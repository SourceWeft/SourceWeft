import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  marketMcpManifestSchema,
  type MarketMcpManifest,
} from "@sourceweft/market-contracts";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

// The federation sync below probes every remote's endpoint; this is the
// catalog's own database, not the network.
vi.mock("../../../shared/mcp-auth-probe", () => ({
  probeMcpEndpointAuth: async () => "oauth",
}));

const tag = `gh${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const NOW = new Date("2026-10-24T03:00:00Z");

function manifest(
  identifier: string,
  overrides: Partial<MarketMcpManifest> = {},
): MarketMcpManifest {
  return marketMcpManifestSchema.parse({
    schemaVersion: 1,
    identifier,
    version: "1.0.0",
    name: "Notion",
    summary: `MCP server ${identifier} from the MCP registry.`,
    transport: "streamable_http",
    endpointUrl: `https://mcp.${tag}.com/mcp`,
    categories: [],
    ...overrides,
  });
}

describe("GitHub MCP Registry enrichment storage", () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let data: typeof import("@sourceweft/db");
  let ingest: typeof import("../ingest/repository");
  let plan: typeof import("../ingest/plan");
  let repository: typeof import("./repository");
  let federation: typeof import("../federation");
  const originalUrl = process.env.DATABASE_URL;

  // Our Notion-shaped entry: untitled, generic name, no description, a
  // remote under the namespace's domain.
  const identifier = `com.${tag}/mcp`;
  const record = {
    name: `make${tag}/${tag}-mcp-server`,
    matchedBy: "endpoint-domain-org" as const,
    ownerAvatarUrl: "https://avatars.githubusercontent.com/u/4792552?v=4",
    stars: 4676,
    license: "MIT License",
    displayName: "Notion",
    description: `Official MCP server for the ${tag} API`,
    fetchedAt: NOW.toISOString(),
  };

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase("mcp_gh_registry");
    process.env.DATABASE_URL = isolated.url;
    data = await import("@sourceweft/db");
    ingest = await import("../ingest/repository");
    plan = await import("../ingest/plan");
    repository = await import("./repository");
    federation = await import("../federation");
  }, 120_000);

  afterAll(async () => {
    if (data) await data.closeDatabase();
    if (isolated) await isolated.close();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  async function rows() {
    const [version] = await data.db
      .select()
      .from(data.mcpServerVersions)
      .where(
        eq(
          data.mcpServerVersions.id,
          plan.mcpServerVersionId(identifier, "1.0.0"),
        ),
      );
    const [server] = await data.db
      .select()
      .from(data.mcpServers)
      .where(eq(data.mcpServers.id, plan.mcpServerId(identifier)));
    return { version: version!, server: server! };
  }

  test("targets are the latest published versions of public federated servers, with the fields the rules read", async () => {
    await ingest.upsertMarketMcp({
      manifest: manifest(identifier),
      status: "published",
      visibility: "public",
      origin: "upstream",
      source: "registry.test",
      provenanceJson: {
        source: "registry.test",
        authProbe: { result: "oauth" },
        // An untitled entry: what federation keeps of the registry server.
        registryServer: { remotes: [{ url: `https://mcp.${tag}.com/mcp` }] },
      },
    });
    // A submitted server and a private one are not targets.
    await ingest.upsertMarketMcp({
      manifest: manifest(`io.github.${tag}/submitted`, { name: "Submitted" }),
      status: "published",
      visibility: "public",
      origin: "submitted",
    });
    await ingest.upsertMarketMcp({
      manifest: manifest(`io.github.${tag}/private`, { name: "Private" }),
      status: "published",
      visibility: "private",
      origin: "upstream",
      source: "registry.test",
    });
    const targets = (await repository.listGithubRegistryTargets()).filter(
      (target) => target.identifier.includes(tag),
    );
    expect(targets).toEqual([
      {
        serverId: plan.mcpServerId(identifier),
        versionId: plan.mcpServerVersionId(identifier, "1.0.0"),
        identifier,
        name: "Notion",
        summary: `MCP server ${identifier} from the MCP registry.`,
        description: null,
        endpointUrl: `https://mcp.${tag}.com/mcp`,
        untitled: true,
      },
    ]);
  });

  test("a match writes the record onto the provenance, and the rules onto the manifest and the server row", async () => {
    const before = await rows();
    await repository.writeGithubRegistryMatch({
      serverId: plan.mcpServerId(identifier),
      versionId: plan.mcpServerVersionId(identifier, "1.0.0"),
      record,
      patch: { description: record.description, summary: record.description },
      now: NOW,
    });
    const { version, server } = await rows();
    expect(version.provenanceJson).toEqual({
      source: "registry.test",
      authProbe: { result: "oauth" },
      registryServer: { remotes: [{ url: `https://mcp.${tag}.com/mcp` }] },
      githubRegistry: record,
    });
    expect(version.manifestJson).toEqual({
      ...before.version.manifestJson,
      description: record.description,
      summary: record.description,
    });
    expect(server.description).toBe(record.description);
    expect(server.summary).toBe(record.description);
    expect(server.name).toBe("Notion");
    expect(server.updatedAt.getTime()).toBe(NOW.getTime());
  });

  test("a re-run with an empty patch refreshes the record and leaves the server row's updated_at alone", async () => {
    const refreshed = {
      ...record,
      fetchedAt: "2026-10-25T03:00:00.000Z",
      stars: 4700,
    };
    await repository.writeGithubRegistryMatch({
      serverId: plan.mcpServerId(identifier),
      versionId: plan.mcpServerVersionId(identifier, "1.0.0"),
      record: refreshed,
      patch: {},
      now: new Date("2026-10-25T03:00:00Z"),
    });
    const { version, server } = await rows();
    expect(version.provenanceJson).toMatchObject({ githubRegistry: refreshed });
    expect(server.updatedAt.getTime()).toBe(NOW.getTime());
    expect(
      await repository.findStoredGithubRegistryRecords([
        plan.mcpServerVersionId(identifier, "1.0.0"),
        plan.mcpServerVersionId(identifier, "0.9.0"),
      ]),
    ).toEqual(
      new Map([[plan.mcpServerVersionId(identifier, "1.0.0"), refreshed]]),
    );
  });

  test("a federation re-sync carries the record over and keeps the description it earned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              servers: [
                {
                  server: {
                    name: identifier,
                    version: "1.0.0",
                    remotes: [
                      {
                        type: "streamable-http",
                        url: `https://mcp.${tag}.com/mcp`,
                      },
                    ],
                  },
                  _meta: {},
                },
              ],
              metadata: { nextCursor: null },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    try {
      const result = await federation.ingestFromRegistry({
        source: "registry.test",
        baseUrl: "https://registry.test",
        verified: true,
      });
      expect(result.ingested).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
    const { version, server } = await rows();
    expect(version.provenanceJson).toMatchObject({
      source: "registry.test",
      githubRegistry: {
        ...record,
        fetchedAt: "2026-10-25T03:00:00.000Z",
        stars: 4700,
      },
    });
    // Rebuilt from an untitled entry with no description: the name is the
    // generic fallback (the namespace's brand), which the displayName
    // replaces; the row's description is taken again, the summary with it.
    expect(version.manifestJson).toMatchObject({
      name: "Notion",
      description: record.description,
      summary: record.description,
    });
    expect(server.description).toBe(record.description);
    expect(server.name).toBe("Notion");
  });
});
