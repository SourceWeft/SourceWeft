import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  test,
  vi,
} from "vitest";
import { eq, sql } from "drizzle-orm";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import type { EmbeddingIndexIdentity } from "./embedding-identity";

type DatabaseModule = typeof import("@sourceweft/db");
let chunkEmbeddings: DatabaseModule["chunkEmbeddings"];
let database: DatabaseModule["database"];
let db: DatabaseModule["db"];
let documents: DatabaseModule["documents"];
let modelGatewayConfigs: DatabaseModule["modelGatewayConfigs"];
let modelGatewayConfigVersions: DatabaseModule["modelGatewayConfigVersions"];
let modelGatewayProfiles: DatabaseModule["modelGatewayProfiles"];
let modelGatewayProviderConfigs: DatabaseModule["modelGatewayProviderConfigs"];
let modelGatewayRoutes: DatabaseModule["modelGatewayRoutes"];
let sources: DatabaseModule["sources"];
let workspaces: DatabaseModule["workspaces"];
let createSourceDocumentChunksAndEmbeddings: (typeof import("../../modules/sources/repository"))["createSourceDocumentChunksAndEmbeddings"];
let searchChunksByVectorAnn: (typeof import("../../modules/sources/retrieval-repository"))["searchChunksByVectorAnn"];
let searchChunksByVectorExact: (typeof import("../../modules/sources/retrieval-repository"))["searchChunksByVectorExact"];
let syncGlobalModelGatewayConfigFromFile: (typeof import("./config-sync"))["syncGlobalModelGatewayConfigFromFile"];
let EmbeddingIdentityError: (typeof import("./embedding-identity"))["EmbeddingIdentityError"];
let MODEL_GATEWAY_CONFIG_SYNC_LOCK_ID: (typeof import("./embedding-identity"))["MODEL_GATEWAY_CONFIG_SYNC_LOCK_ID"];
let prepareEmbeddingProfile: (typeof import("./embedding-identity"))["prepareEmbeddingProfile"];
let modelCatalog: (typeof import("./model-catalog/registry"))["modelCatalog"];

// Config sync changes deployment-wide tables. Give this fork its own migrated
// database on the existing PostgreSQL service; every query below is real SQL.
describe.sequential("embedding identity in PostgreSQL", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let isolatedDatabase:
    Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  let directory: string;
  let configPath: string;
  let teamId: string;
  let workspaceId: string;
  let sourceId: string;
  let gatewaySlug: string;
  let profileId: string;
  let keyEnv: string;
  let enabledEnv: string;
  let raw: ReturnType<typeof initialConfig>;
  let identity: EmbeddingIndexIdentity;

  function initialConfig() {
    const sharedProfile = {
      gatewaySlug,
      providerName: "identity-test",
      targetModel: "embedding-original",
      routingStrategy: "priority",
      priority: 1,
      weight: 100,
      isDefault: true,
      isActive: true,
      providerRouting: { only: ["original"] },
    };
    return {
      gateways: [
        {
          slug: gatewaySlug,
          providerName: "identity-test",
          providerKind: "openai-compatible",
          baseUrl: "https://embedding.example.test/v1",
          apiKeyEnv: keyEnv,
          activation: { env: enabledEnv, default: true },
          defaultHeaders: { "X-Embedding-Version": "original" },
          supports: ["chat", "embeddings"],
          modelCatalog: { enabled: false },
          isDefault: true,
        },
      ],
      chatProfiles: [
        {
          ...sharedProfile,
          profileAlias: `chat-${profileId}`,
          modelAlias: `chat-${profileId}`,
          targetModel: "chat-test",
        },
      ],
      embeddingProfiles: [
        {
          ...sharedProfile,
          profileId,
          profileAlias: `embedding-${profileId}`,
          modelAlias: `embedding-${profileId}`,
          requestedDimensions: 2 as number | null,
          vectorStrategy: "exact",
        },
      ],
    };
  }

  async function sync(value = raw) {
    await writeFile(configPath, JSON.stringify(value));
    await syncGlobalModelGatewayConfigFromFile(configPath, {
      syncPricing: false,
    });
  }

  function indexInput(token = identity) {
    return {
      teamId,
      workspaceId,
      sourceId,
      sourceRevisionId: null,
      sourceTitle: "Embedding identity test",
      sourceContentText: "indexed content",
      embeddingProfileId: token.profileId,
      embeddingIdentity: token,
      modelAlias: token.profileAlias,
      embeddings: [[0.25, 0.75]],
      requireEmbeddings: true,
      requestedDimensions: token.requestedDimensions,
      chunks: [
        {
          text: "indexed content",
          startIndex: 0,
          endIndex: 15,
          tokenCount: 3,
        },
      ],
      markSourceIndexed: true,
    };
  }

  function queryInput(token = identity) {
    return {
      teamId,
      workspaceId,
      embeddingProfileId: token.profileId,
      embeddingIdentity: token,
      queryEmbedding: [0.25, 0.75],
      topK: 5,
      sourceIds: [sourceId],
    };
  }

  async function snapshot() {
    // Include the entire active version, routes and configuration payload so a
    // refusal cannot pass by preserving vectors while partially changing config.
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
      vectors: await db
        .select()
        .from(chunkEmbeddings)
        .where(eq(chunkEmbeddings.workspaceId, workspaceId))
        .orderBy(chunkEmbeddings.id),
      documents: await db
        .select()
        .from(documents)
        .where(eq(documents.sourceId, sourceId))
        .orderBy(documents.id),
      sources: await db.select().from(sources).where(eq(sources.id, sourceId)),
    };
  }

  beforeAll(async () => {
    isolatedDatabase = await createIsolatedTestDatabase("m05");
    process.env.DATABASE_URL = isolatedDatabase.url;
    // No module that imports the database singleton may load before this point.
    ({
      chunkEmbeddings,
      database,
      db,
      documents,
      modelGatewayConfigs,
      modelGatewayConfigVersions,
      modelGatewayProfiles,
      modelGatewayProviderConfigs,
      modelGatewayRoutes,
      sources,
      workspaces,
    } = await import("@sourceweft/db"));
    ({ createSourceDocumentChunksAndEmbeddings } =
      await import("../../modules/sources/repository"));
    ({ searchChunksByVectorAnn, searchChunksByVectorExact } =
      await import("../../modules/sources/retrieval-repository"));
    ({ syncGlobalModelGatewayConfigFromFile } = await import("./config-sync"));
    ({
      EmbeddingIdentityError,
      MODEL_GATEWAY_CONFIG_SYNC_LOCK_ID,
      prepareEmbeddingProfile,
    } = await import("./embedding-identity"));
    ({ modelCatalog } = await import("./model-catalog/registry"));
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
    [teamId, workspaceId, sourceId, gatewaySlug, profileId] = Array.from(
      { length: 5 },
      () => randomUUID(),
    ) as [string, string, string, string, string];
    keyEnv = `M05_KEY_${randomUUID().replaceAll("-", "_").toUpperCase()}`;
    enabledEnv = `M05_ENABLED_${randomUUID().replaceAll("-", "_").toUpperCase()}`;
    vi.stubEnv(keyEnv, "initial-test-key");
    vi.stubEnv(enabledEnv, "true");
    vi.spyOn(modelCatalog, "refresh").mockResolvedValue(undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error(
        "No external HTTP request is permitted in database identity tests",
      );
    });
    directory = await mkdtemp(join(tmpdir(), "sourceweft-m05-"));
    configPath = join(directory, "gateway.json");
    await db.insert(workspaces).values({
      id: workspaceId,
      organizationId: teamId,
      name: "Embedding identity test",
      slug: workspaceId,
    });
    await db.insert(sources).values({
      id: sourceId,
      teamId,
      workspaceId,
      title: "Embedding identity test",
      contentText: "indexed content",
    });
    raw = initialConfig();
    await sync();
    identity = (await prepareEmbeddingProfile()).identity;
  });

  afterEach(async () => {
    try {
      if (workspaceId)
        await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      if (gatewaySlug)
        await db
          .delete(modelGatewayConfigs)
          .where(eq(modelGatewayConfigs.slug, gatewaySlug));
      if (configPath)
        await db
          .delete(modelGatewayConfigVersions)
          .where(eq(modelGatewayConfigVersions.sourcePath, configPath));
    } finally {
      vi.unstubAllEnvs();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  const incompatibleChanges: Array<{
    name: string;
    apply: (value: ReturnType<typeof initialConfig>) => void;
  }> = [
    {
      name: "same-dimension model replacement",
      apply: (value) => {
        value.embeddingProfiles[0]!.targetModel =
          "different-model-same-dimensions";
      },
    },
    {
      name: "requested dimension change",
      apply: (value) => {
        value.embeddingProfiles[0]!.requestedDimensions = 3;
      },
    },
    {
      name: "Provider endpoint change",
      apply: (value) => {
        value.gateways[0]!.baseUrl = "https://different.example.test/v1";
      },
    },
    {
      name: "Provider routing change",
      apply: (value) => {
        value.embeddingProfiles[0]!.providerRouting = { only: ["different"] };
      },
    },
    {
      name: "opaque Provider header change",
      apply: (value) => {
        value.gateways[0]!.defaultHeaders = {
          "X-Embedding-Version": "different",
        };
      },
    },
    {
      name: "default switch to a newly added profile",
      apply: (value) => {
        value.embeddingProfiles[0]!.isDefault = false;
        value.embeddingProfiles.push({
          ...value.embeddingProfiles[0]!,
          profileId: randomUUID(),
          profileAlias: `new-${randomUUID()}`,
          modelAlias: `new-${randomUUID()}`,
          isDefault: true,
        });
      },
    },
  ];

  test.each(incompatibleChanges)(
    "refuses $name without changing persisted state",
    async ({ apply }) => {
      assert.ok(await createSourceDocumentChunksAndEmbeddings(indexInput()));
      const before = await snapshot();
      apply(raw);
      await assert.rejects(sync(), EmbeddingIdentityError);
      assert.deepEqual(await snapshot(), before);
    },
  );

  test("allows an initial model change before any vector exists and fences the old query", async () => {
    const oldIdentity = identity;
    raw.embeddingProfiles[0]!.targetModel = "replacement-before-first-index";
    await sync();
    identity = (await prepareEmbeddingProfile()).identity;
    assert.equal(identity.providerModel, "replacement-before-first-index");
    assert.notEqual(identity.revision, oldIdentity.revision);
    const before = await snapshot();
    await assert.rejects(
      searchChunksByVectorExact(queryInput(oldIdentity)),
      EmbeddingIdentityError,
    );
    await assert.rejects(
      searchChunksByVectorAnn({ ...queryInput(oldIdentity), dim: 2 }),
      EmbeddingIdentityError,
    );
    assert.deepEqual(await snapshot(), before);
    assert.ok(await createSourceDocumentChunksAndEmbeddings(indexInput()));
    assert.equal((await searchChunksByVectorExact(queryInput())).length, 1);
    assert.equal(
      (await searchChunksByVectorAnn({ ...queryInput(), dim: 2 })).length,
      1,
    );
  });

  test("rotating a non-empty API key keeps the index identity and safe configuration hash", async () => {
    assert.ok(await createSourceDocumentChunksAndEmbeddings(indexInput()));
    const before = await snapshot();
    vi.stubEnv(keyEnv, "rotated-test-key");
    await sync();
    const current = await prepareEmbeddingProfile();
    assert.deepEqual(current.identity, identity);
    const after = await snapshot();
    assert.deepEqual(
      after.versions.map((row) => row.versionHash),
      before.versions.map((row) => row.versionHash),
    );
    assert.deepEqual(after.vectors, before.vectors);
    assert.deepEqual(after.documents, before.documents);
    assert.equal((await searchChunksByVectorExact(queryInput())).length, 1);
    assert.equal(JSON.stringify(current.identity).includes("test-key"), false);
  });

  test.each(["disabled", "credential-removed"])(
    "Provider %s updates deployment readiness without reinterpreting vectors",
    async (change) => {
      assert.ok(await createSourceDocumentChunksAndEmbeddings(indexInput()));
      const before = await snapshot();
      if (change === "disabled") vi.stubEnv(enabledEnv, "false");
      else vi.stubEnv(keyEnv, "");
      await sync();
      const current = await prepareEmbeddingProfile();
      assert.deepEqual(current.identity, identity);
      const after = await snapshot();
      assert.deepEqual(after.vectors, before.vectors);
      assert.deepEqual(after.documents, before.documents);
      const gateway = after.gateways.find((row) => row.slug === gatewaySlug);
      assert.ok(gateway);
      assert.equal(gateway.isActive, change !== "disabled");
      if (change === "credential-removed")
        assert.equal(gateway.apiKeyEncrypted, null);
      const activation = gateway.configJson.activation as {
        configured: boolean;
        globalReady: boolean;
      };
      assert.equal(activation.globalReady, false);
      assert.equal(activation.configured, change !== "credential-removed");
    },
  );

  test("an empty index allows a new default even when it is inserted before the old default", async () => {
    const oldIdentity = identity;
    const oldProfile = { ...raw.embeddingProfiles[0]!, isDefault: false };
    const replacement = {
      ...oldProfile,
      profileId: randomUUID(),
      profileAlias: `new-${randomUUID()}`,
      modelAlias: `new-${randomUUID()}`,
      targetModel: "new-default",
      isDefault: true,
    };
    raw.embeddingProfiles = [replacement, oldProfile];
    await sync();
    const current = await prepareEmbeddingProfile();
    assert.equal(current.identity.profileId, replacement.profileId);
    const defaults = (await snapshot()).profiles.filter(
      (row) => row.kind === "embedding" && row.isDefault,
    );
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0]?.id, replacement.profileId);
    await assert.rejects(
      createSourceDocumentChunksAndEmbeddings(indexInput(oldIdentity)),
      EmbeddingIdentityError,
    );
  });

  test("an explicit mismatched document identity cannot enter vector retrieval", async () => {
    const indexed = await createSourceDocumentChunksAndEmbeddings(indexInput());
    assert.ok(indexed);
    await db
      .update(documents)
      .set({
        documentMetadata: {
          embeddingIdentity: {
            ...identity,
            providerModel: "different-recorded-model",
          },
        },
      })
      .where(eq(documents.id, indexed.documentId));
    const before = await snapshot();
    await assert.rejects(
      searchChunksByVectorExact(queryInput()),
      EmbeddingIdentityError,
    );
    await assert.rejects(
      searchChunksByVectorAnn({ ...queryInput(), dim: 2 }),
      EmbeddingIdentityError,
    );
    assert.deepEqual(await snapshot(), before);
  });

  test("synchronizing a legacy configuration does not assign provenance to unmarked vectors", async () => {
    const indexed = await createSourceDocumentChunksAndEmbeddings(indexInput());
    assert.ok(indexed);
    // Recreate a pre-M05 persisted record: vector/profile exist, while neither
    // the profile definition nor the document claims an embedding identity.
    await db
      .update(modelGatewayProfiles)
      .set({
        configJson: sql`${modelGatewayProfiles.configJson} - 'embeddingDefinition'`,
      })
      .where(eq(modelGatewayProfiles.id, profileId));
    await db
      .update(documents)
      .set({
        documentMetadata: sql`${documents.documentMetadata} - 'embeddingIdentity'`,
      })
      .where(eq(documents.id, indexed.documentId));
    const before = await snapshot();
    await sync();
    identity = (await prepareEmbeddingProfile()).identity;
    const after = await snapshot();
    assert.deepEqual(after.documents, before.documents);
    assert.deepEqual(after.vectors, before.vectors);
    assert.equal(
      after.documents[0]?.documentMetadata.embeddingIdentity,
      undefined,
    );
    // Compatibility keeps historical reads available, without manufacturing
    // provenance. A successful sync alone must never mark these vectors verified.
    assert.equal((await searchChunksByVectorExact(queryInput())).length, 1);
    assert.equal(
      (await searchChunksByVectorAnn({ ...queryInput(), dim: 2 })).length,
      1,
    );
  });

  test("a first vector writer that commits before sync prevents incompatible activation", async () => {
    const locked = barrier();
    const resume = barrier();
    const indexing = createSourceDocumentChunksAndEmbeddings(indexInput(), {
      onStage: async (stage) => {
        if (stage === "source_locked") {
          locked.release();
          await resume.promise;
        }
      },
    });
    let syncing: Promise<void> | undefined;
    try {
      await locked.promise;
      raw.embeddingProfiles[0]!.targetModel = "incompatible-after-first-vector";
      syncing = sync();
      // Register the rejection expectation immediately, before releasing the
      // transaction, so a fast refusal cannot become an unhandled rejection.
      const syncRefused = assert.rejects(syncing, EmbeddingIdentityError);
      await waitForConfigLock("ExclusiveLock");
      resume.release();
      assert.ok(await indexing);
      const afterWrite = await snapshot();
      await syncRefused;
      assert.deepEqual(await snapshot(), afterWrite);
      assert.deepEqual((await prepareEmbeddingProfile()).identity, identity);
    } finally {
      resume.release();
      await Promise.allSettled([indexing, ...(syncing ? [syncing] : [])]);
    }
  });

  test.each([2, 3])(
    "unknown dimensions serialize first writes across sources when dimension %i arrives first",
    async (firstDim) => {
      raw.embeddingProfiles[0]!.requestedDimensions = null;
      await sync();
      identity = (await prepareEmbeddingProfile()).identity;
      const secondSourceId = randomUUID();
      await db.insert(sources).values({
        id: secondSourceId,
        teamId,
        workspaceId,
        title: "Concurrent source with different dimensions",
        contentText: "indexed content",
      });
      const secondSourceBefore = await db
        .select()
        .from(sources)
        .where(eq(sources.id, secondSourceId));
      const locked = barrier();
      const resume = barrier();
      const first = createSourceDocumentChunksAndEmbeddings(
        {
          ...indexInput(),
          embeddings: [Array.from({ length: firstDim }, () => 0.5)],
        },
        {
          onStage: async (stage) => {
            if (stage === "source_locked") {
              locked.release();
              await resume.promise;
            }
          },
        },
      );
      let second:
        ReturnType<typeof createSourceDocumentChunksAndEmbeddings> | undefined;
      try {
        await locked.promise;
        second = createSourceDocumentChunksAndEmbeddings({
          ...indexInput(),
          sourceId: secondSourceId,
          embeddings: [
            Array.from({ length: firstDim === 2 ? 3 : 2 }, () => 0.5),
          ],
        });
        const secondRefused = assert.rejects(second, EmbeddingIdentityError);
        await waitForProfileWriteLock();
        resume.release();
        assert.ok(await first);
        await secondRefused;
        const after = await snapshot();
        assert.equal(after.vectors.length, 1);
        assert.equal(after.vectors[0]?.dim, firstDim);
        assert.equal(after.documents.length, 1);
        assert.deepEqual(
          await db
            .select()
            .from(documents)
            .where(eq(documents.sourceId, secondSourceId)),
          [],
        );
        assert.deepEqual(
          await db.select().from(sources).where(eq(sources.id, secondSourceId)),
          secondSourceBefore,
        );
      } finally {
        resume.release();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    },
  );

  test.each(["exact", "ann"])(
    "an unknown-dimension %s query holds its read lock until the first write can proceed",
    async (strategy) => {
      raw.embeddingProfiles[0]!.requestedDimensions = null;
      await sync();
      identity = (await prepareEmbeddingProfile()).identity;
      const secondSourceId = randomUUID();
      await db.insert(sources).values({
        id: secondSourceId,
        teamId,
        workspaceId,
        title: "First vector write during a query",
        contentText: "indexed content",
      });
      const checked = barrier();
      const resume = barrier();
      const dependencies = {
        onIdentityChecked: async () => {
          checked.release();
          await resume.promise;
        },
      };
      const input = { ...queryInput(), sourceIds: [sourceId, secondSourceId] };
      const querying =
        strategy === "exact"
          ? searchChunksByVectorExact(input, dependencies)
          : searchChunksByVectorAnn({ ...input, dim: 2 }, dependencies);
      let indexing:
        ReturnType<typeof createSourceDocumentChunksAndEmbeddings> | undefined;
      try {
        await checked.promise;
        indexing = createSourceDocumentChunksAndEmbeddings({
          ...indexInput(),
          sourceId: secondSourceId,
          embeddings: [[0.5, 0.5, 0.5]],
        });
        await waitForProfileWriteLock();
        resume.release();
        assert.deepEqual(await querying, []);
        assert.ok(await indexing);
        const after = await snapshot();
        assert.equal(after.vectors.length, 1);
        assert.equal(after.vectors[0]?.dim, 3);
      } finally {
        resume.release();
        await Promise.allSettled([querying, ...(indexing ? [indexing] : [])]);
      }
    },
  );

  test("an empty-index sync that commits first rejects an already-computed old vector", async () => {
    const locked = barrier();
    const resume = barrier();
    const blocker = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${MODEL_GATEWAY_CONFIG_SYNC_LOCK_ID})`,
      );
      locked.release();
      await resume.promise;
    });
    let syncing: Promise<void> | undefined;
    let indexing:
      ReturnType<typeof createSourceDocumentChunksAndEmbeddings> | undefined;
    try {
      await locked.promise;
      raw.embeddingProfiles[0]!.targetModel = "activated-before-first-vector";
      syncing = sync();
      await waitForConfigLock("ExclusiveLock");
      indexing = createSourceDocumentChunksAndEmbeddings(indexInput());
      const writeRefused = assert.rejects(indexing, EmbeddingIdentityError);
      await waitForConfigLock("ShareLock");
      resume.release();
      await blocker;
      await syncing;
      await writeRefused;
      const after = await snapshot();
      assert.equal(after.vectors.length, 0);
      assert.equal(after.documents.length, 0);
      assert.notEqual(
        (await prepareEmbeddingProfile()).identity.revision,
        identity.revision,
      );
    } finally {
      resume.release();
      await Promise.allSettled([
        blocker,
        ...(syncing ? [syncing] : []),
        ...(indexing ? [indexing] : []),
      ]);
    }
  });
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitForConfigLock(mode: "ShareLock" | "ExclusiveLock") {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await database.query(
      `select 1 from pg_locks where locktype = 'advisory'
       and database = (select oid from pg_database where datname = current_database())
       and objid = $1 and mode = $2 and not granted`,
      [MODEL_GATEWAY_CONFIG_SYNC_LOCK_ID, mode],
    );
    if (result.rows.length > 0) return;
    await delay(10);
  }
  throw new Error(
    `Expected a real PostgreSQL ${mode} wait for embedding config`,
  );
}

async function waitForProfileWriteLock() {
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
    "Expected a concurrent first vector write to wait for its profile row lock",
  );
}
