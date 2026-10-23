import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  marketMcpManifestSchema,
  type MarketMcpManifest,
} from "@sourceweft/market-contracts";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

/**
 * The stdio validation's rows against a real database: what is due, the
 * claim and its lease, what a success and a failure write, what the 30-day
 * refresh re-opens, and — the part no unit test can show — that a
 * federation re-sync keeps what the validation stored.
 */

const DAY = 24 * 60 * 60 * 1000;
const tag = `sv${randomUUID().replaceAll("-", "").slice(0, 12)}`;

function manifest(
  name: string,
  overrides: Partial<MarketMcpManifest> = {},
): MarketMcpManifest {
  return marketMcpManifestSchema.parse({
    schemaVersion: 1,
    identifier: `io.github.${tag}/${name}`,
    version: "1.0.0",
    name: `${tag} ${name}`,
    summary: `${name} server`,
    transport: "stdio",
    categories: ["developer-tools"],
    ...overrides,
  });
}

const NPM_PACKAGES = [
  { registryType: "npm", identifier: "acme-server", version: "1.0.0" },
];

function provenance(packages: unknown) {
  return {
    source: "registry.test",
    registryServer: packages === undefined ? {} : { packages },
  };
}

const federated = {
  status: "published" as const,
  visibility: "public" as const,
  origin: "upstream" as const,
  source: "registry.test",
};

describe("MCP stdio validation storage", () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let data: typeof import("@sourceweft/db");
  let ingest: typeof import("../ingest/repository");
  let plan: typeof import("../ingest/plan");
  let repository: typeof import("./stdio-repository");
  let reads: typeof import("../read-repository");
  const originalUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase("mcp_stdio");
    process.env.DATABASE_URL = isolated.url;
    data = await import("@sourceweft/db");
    ingest = await import("../ingest/repository");
    plan = await import("../ingest/plan");
    repository = await import("./stdio-repository");
    reads = await import("../read-repository");
  }, 120_000);

  afterAll(async () => {
    if (data) await data.closeDatabase();
    if (isolated) await isolated.close();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  async function versionRow(identifier: string, version = "1.0.0") {
    const [row] = await data.db
      .select()
      .from(data.mcpServerVersions)
      .where(
        eq(
          data.mcpServerVersions.id,
          plan.mcpServerVersionId(identifier, version),
        ),
      );
    return row!;
  }

  const dueIds = async (now?: Date) =>
    (await repository.findDueMcpStdioValidations({ limit: 100, now }))
      .map((entry) => entry.identifier)
      .filter((identifier) => identifier.includes(tag))
      .sort();

  test("only the latest published version of a public server with packages is due; a claim holds it for the lease", async () => {
    const withPackages = manifest("with-packages");
    const remoteOnly = manifest("remote-only", {
      transport: "streamable_http",
      endpointUrl: "https://remote.example.com/mcp",
    });
    const unlisted = manifest("unlisted");
    await ingest.upsertMarketMcp({
      ...federated,
      manifest: withPackages,
      provenanceJson: provenance(NPM_PACKAGES),
    });
    await ingest.upsertMarketMcp({
      ...federated,
      manifest: remoteOnly,
      provenanceJson: provenance(undefined),
    });
    await ingest.upsertMarketMcp({
      ...federated,
      visibility: "private",
      manifest: unlisted,
      provenanceJson: provenance(NPM_PACKAGES),
    });
    expect(await dueIds()).toEqual([withPackages.identifier]);

    const now = new Date();
    const claimed = await repository.claimMcpStdioValidations({
      versionIds: [
        plan.mcpServerVersionId(withPackages.identifier, "1.0.0"),
        plan.mcpServerVersionId(remoteOnly.identifier, "1.0.0"),
        "not-a-version",
      ],
      now,
    });
    expect(claimed.map((row) => row.identifier)).toEqual([
      withPackages.identifier,
    ]);
    expect(claimed[0]!.version).toBe("1.0.0");
    expect(claimed[0]!.provenanceJson.registryServer).toEqual({
      packages: NPM_PACKAGES,
    });
    expect(claimed[0]!.provenanceJson.stdioValidation).toEqual({
      attemptedAt: now.toISOString(),
    });

    // Claimed: not due again until the lease lapses, then due again (no
    // outcome was written — the worker died).
    expect(await dueIds(now)).toEqual([]);
    expect(
      await repository.claimMcpStdioValidations({
        versionIds: [claimed[0]!.versionId],
        now,
      }),
    ).toEqual([]);
    const afterLease = new Date(
      now.getTime() + repository.MCP_STDIO_CLAIM_LEASE_MS + 1000,
    );
    expect(await dueIds(afterLease)).toEqual([withPackages.identifier]);
  });

  test("a success writes the self-description, validatedAt, the tools and the count; a re-sync keeps them", async () => {
    const notion = manifest("notion");
    await ingest.upsertMarketMcp({
      ...federated,
      manifest: notion,
      provenanceJson: provenance(NPM_PACKAGES),
    });
    const versionId = plan.mcpServerVersionId(notion.identifier, "1.0.0");
    const serverId = plan.mcpServerId(notion.identifier);
    const now = new Date();
    await repository.claimMcpStdioValidations({ versionIds: [versionId], now });
    // A stale failure from an earlier try goes with the success.
    await repository.writeMcpStdioValidationFailure({
      versionId,
      validation: {
        status: "failed",
        reason: "timeout",
        at: new Date(now.getTime() - 40 * DAY).toISOString(),
      },
    });
    const tools = [
      {
        name: "search",
        description: "Search",
        inputSchema: {},
        annotations: {},
        risk: "unknown" as const,
      },
      {
        name: "create",
        inputSchema: { type: "object" },
        annotations: {},
        risk: "unknown" as const,
      },
    ];
    await repository.writeMcpStdioValidationSuccess({
      versionId,
      serverId,
      selfDescription: {
        source: "stdio-sandbox",
        recordedAt: now.toISOString(),
        serverInfo: { name: "Notion API", version: "1.0.0" },
      },
      validatedAt: now.toISOString(),
      tools,
    });

    let row = await versionRow(notion.identifier);
    expect(row.provenanceJson.validation).toBeUndefined();
    expect(row.provenanceJson.validatedAt).toBe(now.toISOString());
    expect(row.provenanceJson.selfDescription).toEqual({
      source: "stdio-sandbox",
      recordedAt: now.toISOString(),
      serverInfo: { name: "Notion API", version: "1.0.0" },
    });
    expect(row.provenanceJson.stdioValidation).toEqual({
      attemptedAt: now.toISOString(),
    });
    expect(row.manifestJson.tools).toEqual(tools);
    let record = await reads.findMcp(notion.identifier);
    expect(record?.item.toolsCount).toBe(2);
    expect(record?.item.toolsValidation).toBeNull();
    expect(await dueIds(now)).not.toContain(notion.identifier);

    // The registry entry lists no tools; the next sync must not take them.
    await ingest.upsertMarketMcp({
      ...federated,
      manifest: { ...notion, summary: "resynced" },
      provenanceJson: { ...provenance(NPM_PACKAGES), meta: { synced: 2 } },
    });
    row = await versionRow(notion.identifier);
    expect(row.manifestJson.tools).toEqual(tools);
    expect(row.manifestJson.summary).toBe("resynced");
    expect(row.provenanceJson.validatedAt).toBe(now.toISOString());
    expect(row.provenanceJson.selfDescription).toMatchObject({
      source: "stdio-sandbox",
    });
    expect(row.provenanceJson.meta).toEqual({ synced: 2 });
    record = await reads.findMcp(notion.identifier);
    expect(record?.item.toolsCount).toBe(2);
    const listed = await reads.listMcp({ query: notion.identifier });
    expect(
      listed.items.find((item) => item.identifier === notion.identifier)
        ?.toolsCount,
    ).toBe(2);

    // A sync that brings its own self-description and tools (a remote probe)
    // wins over the stored ones.
    await ingest.upsertMarketMcp({
      ...federated,
      manifest: { ...notion, tools: [tools[0]!] },
      provenanceJson: {
        ...provenance(NPM_PACKAGES),
        selfDescription: { source: "remote-probe", recordedAt: "later" },
      },
    });
    row = await versionRow(notion.identifier);
    expect(row.manifestJson.tools).toEqual([tools[0]]);
    expect(row.provenanceJson.selfDescription).toEqual({
      source: "remote-probe",
      recordedAt: "later",
    });
    expect(row.provenanceJson.validatedAt).toBe(now.toISOString());

    // Due again 30 days after the success.
    const later = new Date(
      now.getTime() + repository.MCP_STDIO_CLAIM_LEASE_MS + 31 * DAY,
    );
    expect(await dueIds(later)).toContain(notion.identifier);
  });

  test("a failure writes the validation record, leaves the tools alone, and shows on the summary; a re-sync keeps it", async () => {
    const broken = manifest("broken");
    await ingest.upsertMarketMcp({
      ...federated,
      manifest: broken,
      provenanceJson: provenance(NPM_PACKAGES),
    });
    const versionId = plan.mcpServerVersionId(broken.identifier, "1.0.0");
    const now = new Date();
    await repository.claimMcpStdioValidations({ versionIds: [versionId], now });
    const validation = {
      status: "failed" as const,
      reason: "start" as const,
      at: now.toISOString(),
      detail: "server exited with 1 before answering initialize: boom",
    };
    await repository.writeMcpStdioValidationFailure({ versionId, validation });

    let row = await versionRow(broken.identifier);
    expect(row.provenanceJson.validation).toEqual(validation);
    expect(row.provenanceJson.validatedAt).toBeUndefined();
    expect(row.manifestJson.tools).toEqual([]);
    let record = await reads.findMcp(broken.identifier);
    expect(record?.item.toolsCount).toBe(0);
    expect(record?.item.toolsValidation).toEqual({
      status: "failed",
      reason: "start",
      at: now.toISOString(),
    });
    expect(await dueIds(now)).not.toContain(broken.identifier);

    await ingest.upsertMarketMcp({
      ...federated,
      manifest: broken,
      provenanceJson: provenance(NPM_PACKAGES),
    });
    row = await versionRow(broken.identifier);
    expect(row.provenanceJson.validation).toEqual(validation);
    record = await reads.findMcp(broken.identifier);
    expect(record?.item.toolsValidation?.reason).toBe("start");

    const counts = await repository.countMcpStdioValidations(now);
    expect(counts.failed).toBeGreaterThanOrEqual(1);
    expect(counts.validated).toBeGreaterThanOrEqual(1);

    // Tried again after 30 days.
    const later = new Date(now.getTime() + 31 * DAY);
    expect(await dueIds(later)).toContain(broken.identifier);
  });
});
