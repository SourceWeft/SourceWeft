import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  test,
  vi,
} from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import type { GlobalProfilePricingEntry } from "./global-config";
import { emptyModelInfo } from "./model-catalog/types";

type DatabaseModule = typeof import("@sourceweft/db");
let database: DatabaseModule["database"];
let db: DatabaseModule["db"];
let modelGatewayConfigs: DatabaseModule["modelGatewayConfigs"];
let modelGatewayConfigVersions: DatabaseModule["modelGatewayConfigVersions"];
let modelGatewayProfiles: DatabaseModule["modelGatewayProfiles"];
let modelGatewayProviderConfigs: DatabaseModule["modelGatewayProviderConfigs"];
let modelGatewayRoutes: DatabaseModule["modelGatewayRoutes"];
let syncGlobalModelGatewayConfigFromFile: (typeof import("./config-sync"))["syncGlobalModelGatewayConfigFromFile"];
let modelCatalog: (typeof import("./model-catalog/registry"))["modelCatalog"];
let syncModelPricing: (typeof import("./sync-pricing"))["syncModelPricing"];

// These tests exercise the real file loader, sync transaction and repositories
// in an independently migrated PostgreSQL database. Only external catalog data
// is substituted: this is database atomicity coverage, not HTTP integration.
describe.sequential("catalog sync atomicity in PostgreSQL", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let isolatedDatabase:
    Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  let directory: string;
  let configPath: string;
  let gatewaySlug: string;
  let keyEnv: string;
  let enabledEnv: string;
  let raw: ReturnType<typeof initialConfig>;

  function initialConfig() {
    const common = {
      gatewaySlug,
      providerName: "catalog-atomicity-test",
      routingStrategy: "priority",
      priority: 1,
      weight: 100,
      isDefault: true,
      isActive: true,
      pricing: {
        source: "manual",
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0.000002,
      } as GlobalProfilePricingEntry | null,
    };
    return {
      gateways: [
        {
          slug: gatewaySlug,
          providerName: common.providerName,
          providerKind: "openai-compatible",
          baseUrl: "https://catalog.example.test/v1",
          apiKeyEnv: keyEnv,
          activation: { env: enabledEnv, default: true },
          supports: ["chat", "tool_calling", "embeddings"],
          modelCatalog: { enabled: true, kinds: ["chat"] },
          isDefault: true,
        },
      ],
      chatProfiles: [
        {
          ...common,
          profileAlias: `static-chat-${gatewaySlug}`,
          modelAlias: `static-chat-${gatewaySlug}`,
          targetModel: "static-chat-original",
        },
      ],
      embeddingProfiles: [
        {
          ...common,
          profileId: randomUUID(),
          profileAlias: `static-embedding-${gatewaySlug}`,
          modelAlias: `static-embedding-${gatewaySlug}`,
          targetModel: "static-embedding-original",
          requestedDimensions: 2,
          vectorStrategy: "exact",
        },
      ],
    };
  }

  async function sync(syncPricing = false) {
    await writeFile(configPath, JSON.stringify(raw));
    await syncGlobalModelGatewayConfigFromFile(configPath, { syncPricing });
  }

  async function snapshot() {
    // Compare complete rows, including hash, payload, timestamps and credentials.
    // A failure must not leave a half-version or alter an existing profile.
    return {
      versions: await db
        .select()
        .from(modelGatewayConfigVersions)
        .orderBy(modelGatewayConfigVersions.id),
      gateways: await db
        .select()
        .from(modelGatewayConfigs)
        .orderBy(modelGatewayConfigs.id),
      providers: await db
        .select()
        .from(modelGatewayProviderConfigs)
        .orderBy(modelGatewayProviderConfigs.id),
      profiles: await db
        .select()
        .from(modelGatewayProfiles)
        .orderBy(modelGatewayProfiles.id),
      routes: await db
        .select()
        .from(modelGatewayRoutes)
        .orderBy(modelGatewayRoutes.id),
    };
  }

  beforeAll(async () => {
    isolatedDatabase = await createIsolatedTestDatabase("m06_catalog");
    process.env.DATABASE_URL = isolatedDatabase.url;
    // Import no database singleton until the private database URL is installed.
    ({
      database,
      db,
      modelGatewayConfigs,
      modelGatewayConfigVersions,
      modelGatewayProfiles,
      modelGatewayProviderConfigs,
      modelGatewayRoutes,
    } = await import("@sourceweft/db"));
    ({ syncGlobalModelGatewayConfigFromFile } = await import("./config-sync"));
    ({ modelCatalog } = await import("./model-catalog/registry"));
    ({ syncModelPricing } = await import("./sync-pricing"));
  }, 120_000);

  afterAll(async () => {
    try {
      if (database) await database.end();
      await isolatedDatabase?.close();
    } finally {
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  beforeEach(async () => {
    // This database belongs only to this sequential suite. Clear deployment
    // tables so prior cases cannot supply profiles or cached active versions.
    await db.delete(modelGatewayRoutes);
    await db.delete(modelGatewayProviderConfigs);
    await db.delete(modelGatewayProfiles);
    await db.delete(modelGatewayConfigs);
    await db.delete(modelGatewayConfigVersions);
    gatewaySlug = randomUUID();
    keyEnv = `M06_KEY_${randomUUID().replaceAll("-", "_").toUpperCase()}`;
    enabledEnv = `M06_ENABLED_${randomUUID().replaceAll("-", "_").toUpperCase()}`;
    vi.stubEnv(keyEnv, "catalog-atomicity-test-key");
    vi.stubEnv(enabledEnv, "true");
    vi.spyOn(modelCatalog, "refresh").mockResolvedValue(undefined);
    vi.spyOn(modelCatalog, "resolve").mockImplementation((id) => ({
      ...emptyModelInfo(id),
      modality: "chat",
      toolCall: true,
      pricing: { inputPerToken: 0.000001, outputPerToken: 0.000002 },
      sources: ["database-test-fixture"],
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      assert.ok(input instanceof Request);
      assert.equal(input.url, "https://catalog.example.test/v1/models");
      assert.equal(
        input.headers.get("authorization"),
        "Bearer catalog-atomicity-test-key",
      );
      return Response.json({ data: [{ id: "catalog-chat-original" }] });
    });
    directory = await mkdtemp(join(tmpdir(), "sourceweft-m06-catalog-"));
    configPath = join(directory, "gateway.json");
    raw = initialConfig();
    await sync();
    const before = await snapshot();
    assert.equal(before.versions.filter((row) => row.isActive).length, 1);
    assert.ok(
      before.profiles.some(
        (row) =>
          row.isActive &&
          row.configJson.targetModel === "catalog-chat-original",
      ),
    );
    vi.mocked(modelCatalog.refresh).mockClear();
    vi.mocked(globalThis.fetch).mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test("a required registry failure preserves the complete previous configuration", async () => {
    const before = await snapshot();
    raw.chatProfiles[0]!.targetModel = "new-static-chat-not-activated";
    vi.mocked(modelCatalog.refresh).mockRejectedValue(
      new Error("Required registry source unavailable"),
    );
    await assert.rejects(sync(), /Required registry source unavailable/);
    assert.deepEqual(await snapshot(), before);
    assert.equal(vi.mocked(globalThis.fetch).mock.calls.length, 0);
  });

  test("automatic pricing loads its required registry before changing the active version", async () => {
    const before = await snapshot();
    raw.gateways[0]!.modelCatalog.enabled = false;
    raw.chatProfiles[0]!.targetModel = "automatic-price-not-activated";
    // Null explicitly clears the old operator price and requests auto pricing.
    raw.chatProfiles[0]!.pricing = null;
    vi.mocked(modelCatalog.refresh).mockRejectedValue(
      new Error("Required pricing registry unavailable"),
    );
    await assert.rejects(sync(true), /Required pricing registry unavailable/);
    assert.deepEqual(await snapshot(), before);
    assert.equal(vi.mocked(globalThis.fetch).mock.calls.length, 0);
  });

  test("a ready Provider catalog failure preserves all profiles, routes and the previous hash", async () => {
    const before = await snapshot();
    raw.chatProfiles[0]!.targetModel = "new-static-chat-not-activated";
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("Catalog unavailable", { status: 503 }),
    );
    await assert.rejects(sync(), /Failed to discover model catalog/);
    assert.deepEqual(await snapshot(), before);
    assert.equal(vi.mocked(modelCatalog.refresh).mock.calls.length, 1);
    assert.equal(vi.mocked(globalThis.fetch).mock.calls.length, 1);
  });

  test("OpenRouter missing dynamic prices loads the registry before any configuration mutation", async () => {
    // Establish a purely static/manual baseline and deactivate the initial
    // generic catalog models before changing this Provider to OpenRouter.
    raw.gateways[0]!.modelCatalog.enabled = false;
    await sync(true);
    assert.equal(vi.mocked(modelCatalog.refresh).mock.calls.length, 0);
    raw.gateways[0]!.providerKind = "openrouter";
    raw.gateways[0]!.modelCatalog.enabled = true;
    const selfDescribedModel = {
      id: "openai/catalog-dynamic-chat",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      supported_parameters: ["tools"],
    };
    vi.mocked(modelCatalog.refresh).mockRejectedValue(
      new Error("Required dynamic pricing registry unavailable"),
    );
    vi.mocked(globalThis.fetch).mockResolvedValue(
      Response.json({
        data: [
          {
            ...selfDescribedModel,
            pricing: { prompt: "0.000001", completion: "0.000002" },
          },
        ],
      }),
    );
    // Provider-supplied capabilities and prices are sufficient on their own.
    await sync(true);
    assert.equal(vi.mocked(modelCatalog.refresh).mock.calls.length, 0);
    assert.equal(vi.mocked(globalThis.fetch).mock.calls.length, 1);
    const before = await snapshot();
    assert.ok(
      before.profiles.some(
        (row) =>
          row.isActive && row.configJson.targetModel === selfDescribedModel.id,
      ),
    );

    raw.chatProfiles[0]!.targetModel = "static-change-not-activated";
    vi.mocked(globalThis.fetch).mockResolvedValue(
      Response.json({ data: [selfDescribedModel] }),
    );
    await assert.rejects(
      sync(true),
      /Required dynamic pricing registry unavailable/,
    );
    assert.equal(vi.mocked(globalThis.fetch).mock.calls.length, 2);
    assert.equal(vi.mocked(modelCatalog.refresh).mock.calls.length, 1);
    assert.deepEqual(await snapshot(), before);
  });

  test.each(["disabled", "missing-key"])(
    "a %s Provider triggers neither registry nor authenticated discovery",
    async (state) => {
      if (state === "disabled") vi.stubEnv(enabledEnv, "false");
      else vi.stubEnv(keyEnv, "");
      // An automatic price on a non-ready target must not introduce network access.
      raw.chatProfiles[0]!.pricing = null;
      vi.mocked(modelCatalog.refresh).mockRejectedValue(
        new Error("Registry must not load for non-ready targets"),
      );
      vi.mocked(globalThis.fetch).mockRejectedValue(
        new Error("Catalog must not fetch for non-ready targets"),
      );
      await sync(true);
      assert.equal(vi.mocked(modelCatalog.refresh).mock.calls.length, 0);
      assert.equal(vi.mocked(globalThis.fetch).mock.calls.length, 0);
      const current = await snapshot();
      const gateway = current.gateways.find((row) => row.slug === gatewaySlug);
      assert.ok(gateway);
      assert.equal(gateway.isActive, state !== "disabled");
      assert.equal(
        (gateway.configJson.activation as { globalReady: boolean }).globalReady,
        false,
      );
      assert.equal(current.versions.filter((row) => row.isActive).length, 1);
    },
  );

  test("static models with explicit manual prices sync without external catalog dependencies", async () => {
    raw.gateways[0]!.modelCatalog.enabled = false;
    vi.mocked(modelCatalog.refresh).mockRejectedValue(
      new Error("Static manual config must not load registry"),
    );
    vi.mocked(globalThis.fetch).mockRejectedValue(
      new Error("Static manual config must not use HTTP"),
    );
    await sync(true);
    assert.equal(vi.mocked(modelCatalog.refresh).mock.calls.length, 0);
    assert.equal(vi.mocked(globalThis.fetch).mock.calls.length, 0);
    const current = await snapshot();
    assert.ok(
      current.profiles.some(
        (row) => row.isActive && row.kind === "embedding" && row.isDefault,
      ),
    );
    assert.ok(
      current.profiles.some(
        (row) =>
          row.isActive && row.configJson.targetModel === "static-chat-original",
      ),
    );
  });

  test("disabling a catalog retires imported models even when its discovery source differs from provider kind", async () => {
    const before = await snapshot();
    const dynamic = before.profiles.find(
      (row) => row.configJson.targetModel === "catalog-chat-original",
    )!;
    await db
      .update(modelGatewayProfiles)
      .set({
        configJson: {
          ...dynamic.configJson,
          providerCatalogSource: "custom-format-models",
        },
      })
      .where(eq(modelGatewayProfiles.id, dynamic.id));
    raw.gateways[0]!.modelCatalog.enabled = false;
    await sync();
    const current = await snapshot();
    assert.equal(
      current.profiles.find((row) => row.id === dynamic.id)?.isActive,
      false,
    );
    assert.equal(
      current.routes.some((row) => row.targetModel === "catalog-chat-original"),
      false,
    );
    assert.equal(vi.mocked(globalThis.fetch).mock.calls.length, 0);
    assert.ok(
      current.profiles.find(
        (row) => row.profileAlias === raw.chatProfiles[0]!.profileAlias,
      )?.isActive,
    );
  });

  test("a catalog model promoted to an explicit profile survives disabling discovery", async () => {
    const before = await snapshot();
    const dynamic = before.profiles.find(
      (row) => row.configJson.targetModel === "catalog-chat-original",
    )!;
    raw.chatProfiles.push({
      ...raw.chatProfiles[0]!,
      profileAlias: dynamic.profileAlias,
      modelAlias: dynamic.modelAlias,
      targetModel: "catalog-chat-original",
      isDefault: false,
    });
    raw.gateways[0]!.modelCatalog.enabled = false;
    await sync();
    const current = await snapshot();
    assert.equal(
      current.profiles.find((row) => row.id === dynamic.id)?.isActive,
      true,
    );
    assert.ok(
      current.routes.some((row) => row.targetModel === "catalog-chat-original"),
    );
  });

  test("removing a Provider retires its imported profiles without relying on a disabled-catalog entry", async () => {
    const before = await snapshot();
    const dynamic = before.profiles.find(
      (row) => row.configJson.targetModel === "catalog-chat-original",
    )!;
    const remainingSlug = randomUUID();
    raw.gateways = [
      {
        ...raw.gateways[0]!,
        slug: remainingSlug,
        modelCatalog: { enabled: false, kinds: ["chat"] },
      },
    ];
    raw.chatProfiles[0]!.gatewaySlug = remainingSlug;
    raw.embeddingProfiles[0]!.gatewaySlug = remainingSlug;
    await sync();
    const current = await snapshot();
    assert.equal(
      current.profiles.find((row) => row.id === dynamic.id)?.isActive,
      false,
    );
    assert.equal(
      current.routes.some((row) => row.targetModel === "catalog-chat-original"),
      false,
    );
    assert.equal(vi.mocked(globalThis.fetch).mock.calls.length, 0);
    assert.equal(current.profiles.filter((row) => row.isActive).length, 2);
  });

  test("an empty valid catalog disables stale dynamic models while keeping the explicit default embedding", async () => {
    const before = await snapshot();
    const oldDynamic = before.profiles.find(
      (row) => row.configJson.targetModel === "catalog-chat-original",
    );
    assert.ok(oldDynamic?.isActive);
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ data: [] }));
    await sync();
    const current = await snapshot();
    assert.equal(current.versions.filter((row) => row.isActive).length, 1);
    const stale = current.profiles.find((row) => row.id === oldDynamic.id);
    assert.ok(stale);
    assert.equal(stale.isActive, false);
    assert.equal(stale.isDefault, false);
    assert.equal(
      current.routes.some((row) => row.targetModel === "catalog-chat-original"),
      false,
    );
    const defaults = current.profiles.filter(
      (row) => row.kind === "embedding" && row.isActive && row.isDefault,
    );
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0]?.id, raw.embeddingProfiles[0]!.profileId);
    assert.equal(vi.mocked(globalThis.fetch).mock.calls.length, 1);
  });

  test.each(["matched", "unmatched"])(
    "an old %s pricing task cannot overwrite a newly activated embedding definition or manual price",
    async (lookup) => {
      raw.gateways[0]!.modelCatalog.enabled = false;
      raw.embeddingProfiles[0]!.pricing = null;
      await sync();
      const original = await snapshot();
      const originalEmbedding = original.profiles.find(
        (row) => row.id === raw.embeddingProfiles[0]!.profileId,
      );
      assert.ok(originalEmbedding);
      const metadataReached = barrier();
      const resumeMetadata = barrier();
      vi.spyOn(modelCatalog, "ensureReady").mockImplementation(async () => {
        metadataReached.release();
        await resumeMetadata.promise;
      });
      if (lookup === "unmatched")
        vi.mocked(modelCatalog.resolve).mockReturnValue(null);
      const pricing = syncModelPricing();
      const refused = assert.rejects(
        pricing,
        /configuration changed during pricing sync/,
      );
      try {
        // ensureReady is reached after pricing has read its profile snapshot.
        await metadataReached.promise;
        raw.embeddingProfiles[0]!.targetModel =
          "new-embedding-before-pricing-write";
        raw.embeddingProfiles[0]!.requestedDimensions = 3;
        raw.embeddingProfiles[0]!.pricing = {
          inputCostPerToken: 0.004,
          outputCostPerToken: 0.005,
        };
        await sync();
        const activated = await snapshot();
        const currentEmbedding = activated.profiles.find(
          (row) => row.id === originalEmbedding.id,
        );
        assert.ok(currentEmbedding);
        assert.notDeepEqual(
          currentEmbedding.configJson.embeddingDefinition,
          originalEmbedding.configJson.embeddingDefinition,
        );
        assert.equal(currentEmbedding.configJson.price_source, "manual");
        resumeMetadata.release();
        await refused;
        assert.deepEqual(await snapshot(), activated);
      } finally {
        resumeMetadata.release();
        await Promise.allSettled([pricing, refused]);
      }
    },
  );

  test.each(["matched", "unmatched"])(
    "a same-version %s pricing task preserves a concurrent manual price and non-owned fields",
    async (lookup) => {
      raw.gateways[0]!.modelCatalog.enabled = false;
      raw.embeddingProfiles[0]!.pricing = null;
      await sync();
      const before = await snapshot();
      const profile = before.profiles.find(
        (row) => row.id === raw.embeddingProfiles[0]!.profileId,
      );
      assert.ok(profile);
      const metadataReached = barrier();
      const resumeMetadata = barrier();
      const manualUpdated = barrier();
      const commitManual = barrier();
      vi.spyOn(modelCatalog, "ensureReady").mockImplementation(async () => {
        metadataReached.release();
        await resumeMetadata.promise;
      });
      if (lookup === "unmatched")
        vi.mocked(modelCatalog.resolve).mockReturnValue(null);
      const pricing = syncModelPricing();
      // Attach a handler immediately while the independent transaction runs.
      const pricingOutcome = pricing.then(
        () => null,
        (error: unknown) => error,
      );
      let manualWrite: Promise<void> | undefined;
      const manualChanges = {
        price_source: "manual",
        input_cost_per_token: 0.007,
        output_cost_per_token: 0.008,
        // A pinned price with a lookup key still permits capability enrichment,
        // so the matched case exercises owned-field merging rather than a skip.
        litellm_key: raw.embeddingProfiles[0]!.targetModel,
        operatorNote: { reason: "changed after pricing snapshot" },
      };
      try {
        await metadataReached.promise;
        manualWrite = db.transaction(async (tx) => {
          await tx
            .update(modelGatewayProfiles)
            .set({
              configJson: sql`${modelGatewayProfiles.configJson} || ${JSON.stringify(manualChanges)}::jsonb`,
            })
            .where(eq(modelGatewayProfiles.id, profile.id));
          manualUpdated.release();
          await commitManual.promise;
        });
        await manualUpdated.promise;
        resumeMetadata.release();
        // Prove the real pricing transaction waits on the updated row before
        // the manual writer commits; no sleeps decide which writer wins.
        await waitForPricingProfileLock();
        commitManual.release();
        await manualWrite;
        assert.equal(await pricingOutcome, null);
        const after = await snapshot();
        assert.deepEqual(after.versions, before.versions);
        const current = after.profiles.find((row) => row.id === profile.id);
        assert.ok(current);
        for (const [key, value] of Object.entries(manualChanges)) {
          assert.deepEqual(current.configJson[key], value);
        }
        assert.deepEqual(
          current.configJson.embeddingDefinition,
          profile.configJson.embeddingDefinition,
        );
        if (lookup === "matched")
          assert.equal(current.configJson.supports_function_calling, true);
        else
          assert.deepEqual(current.configJson, {
            ...profile.configJson,
            ...manualChanges,
          });
      } finally {
        resumeMetadata.release();
        commitManual.release();
        await Promise.allSettled([
          pricingOutcome,
          ...(manualWrite ? [manualWrite] : []),
        ]);
      }
    },
  );
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitForPricingProfileLock() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await database.query(`
      select 1 from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and query like '%from "model_gateway_profiles"%'
        and query like '%for update%'
        and cardinality(pg_blocking_pids(pid)) > 0
    `);
    if (result.rows.length > 0) return;
    await delay(10);
  }
  throw new Error(
    "Expected pricing sync to wait for the concurrent manual profile update",
  );
}
