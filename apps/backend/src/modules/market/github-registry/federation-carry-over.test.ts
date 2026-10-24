import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { MarketMcpGithubRegistryProvenance } from "@sourceweft/market-contracts";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  storedProbes: vi.fn(
    async (_versionIds: string[]) => new Map<string, unknown>(),
  ),
  storedRecords: vi.fn(
    async (_versionIds: string[]) => new Map<string, unknown>(),
  ),
  storedIconProvenance: vi.fn(
    async (_versionIds: string[]) => new Map<string, unknown>(),
  ),
}));

vi.mock("../ingest/repository", () => ({
  upsertMarketMcp: mocks.upsert,
  findStoredEndpointProbes: mocks.storedProbes,
  findStoredIconProvenance: mocks.storedIconProvenance,
}));
// No public storage: the favicon step (W3) is skipped, so nothing here
// depends on the ambient PUBLIC_S3_* environment or calls a favicon service.
vi.mock("../icons/store", () => ({
  canStoreMcpIcons: () => false,
  storeMcpIcon: vi.fn(),
}));
vi.mock("./repository", () => ({
  findStoredGithubRegistryRecords: mocks.storedRecords,
}));
vi.mock("../../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import { federateRegistryEntry } from "../federation";
import { mcpServerVersionId } from "../ingest/plan";

const SOURCE = {
  source: "registry.test",
  baseUrl: "https://registry.test",
  verified: true,
};

const RECORD: MarketMcpGithubRegistryProvenance = {
  name: "makenotion/notion-mcp-server",
  matchedBy: "endpoint-domain-org",
  ownerAvatarUrl: "https://avatars.githubusercontent.com/u/4792552?v=4",
  stars: 4676,
  license: "MIT License",
  displayName: "Notion MCP",
  description: "Official MCP server for Notion API",
  fetchedAt: "2026-10-24T03:00:00.000Z",
};

/** A registry answering one Notion-shaped entry, and an open endpoint probe. */
function registryWith(server: Record<string, unknown>) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === "/v0/servers") {
      return new Response(
        JSON.stringify({
          servers: [{ server, _meta: {} }],
          metadata: { count: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    assert.equal(init?.method, "POST");
    return new Response("{}", { status: 200 });
  });
}

const notionEntry = {
  name: "com.notion/mcp",
  version: "1.0.0",
  remotes: [{ type: "streamable-http", url: "https://mcp.notion.com/mcp" }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test("federating one entry again carries its githubRegistry record over and re-applies the rules", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  mocks.storedRecords.mockResolvedValueOnce(
    new Map([[mcpServerVersionId("com.notion/mcp", "1.0.0"), RECORD]]),
  );
  vi.stubGlobal("fetch", registryWith(notionEntry));

  const result = await federateRegistryEntry({
    identifier: "com.notion/mcp",
    source: SOURCE,
  });

  assert.equal(result.found, true);
  assert.equal(result.ingested, 1);
  assert.deepEqual(mocks.storedRecords.mock.calls[0], [
    [mcpServerVersionId("com.notion/mcp", "1.0.0")],
  ]);
  const [{ manifest, provenanceJson }] = mocks.upsert.mock.calls[0]!;
  // The untitled, generic-named entry takes the row's displayName and its
  // longer description (the placeholder summary with it).
  assert.equal(manifest.name, "Notion MCP");
  assert.equal(manifest.description, "Official MCP server for Notion API");
  assert.equal(manifest.summary, "Official MCP server for Notion API");
  assert.deepEqual(provenanceJson.githubRegistry, RECORD);
  // The registry server kept for the version now says it has no title.
  assert.equal(provenanceJson.registryServer.title, undefined);
});

test("a titled entry keeps its title even when it equals the generic fallback", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  mocks.storedRecords.mockResolvedValueOnce(
    new Map([[mcpServerVersionId("com.notion/mcp", "1.0.0"), RECORD]]),
  );
  vi.stubGlobal("fetch", registryWith({ ...notionEntry, title: "Notion" }));

  await federateRegistryEntry({ identifier: "com.notion/mcp", source: SOURCE });

  const [{ manifest, provenanceJson }] = mocks.upsert.mock.calls[0]!;
  assert.equal(manifest.name, "Notion");
  assert.equal(provenanceJson.registryServer.title, "Notion");
  assert.deepEqual(provenanceJson.githubRegistry, RECORD);
});

test("an entry without a stored record is federated as before, with no githubRegistry key", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  vi.stubGlobal("fetch", registryWith(notionEntry));

  await federateRegistryEntry({ identifier: "com.notion/mcp", source: SOURCE });

  const [{ manifest, provenanceJson }] = mocks.upsert.mock.calls[0]!;
  assert.equal(manifest.name, "Notion");
  assert.equal(manifest.description, undefined);
  assert.equal(provenanceJson.githubRegistry, undefined);
});

test("a stored value that is not a record is dropped rather than carried", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  mocks.storedRecords.mockResolvedValueOnce(
    new Map([
      [mcpServerVersionId("com.notion/mcp", "1.0.0"), { name: "garbage" }],
    ]),
  );
  vi.stubGlobal("fetch", registryWith(notionEntry));

  await federateRegistryEntry({ identifier: "com.notion/mcp", source: SOURCE });

  const [{ manifest, provenanceJson }] = mocks.upsert.mock.calls[0]!;
  assert.equal(manifest.name, "Notion");
  assert.equal(provenanceJson.githubRegistry, undefined);
});
