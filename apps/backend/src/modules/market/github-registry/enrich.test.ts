import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test, vi } from "vitest";

const logs = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock("../../../shared/logger", () => ({
  logger: { warn: logs.warn, info: logs.info, debug: vi.fn(), error: vi.fn() },
}));

import {
  matchGithubRegistryRows,
  runGithubRegistryEnrichment,
  type GithubRegistryEnrichmentDeps,
} from "./enrich";
import {
  parseGithubRegistryPage,
  type GithubRegistryFetchResult,
} from "./fetch";
import type { GithubRegistryTarget } from "./repository";

const FIXTURE_ROWS = parseGithubRegistryPage(
  JSON.parse(
    readFileSync(
      new URL("./fixtures/servers-page.json", import.meta.url),
      "utf8",
    ),
  ),
).rows;

const NOW = new Date("2026-10-24T03:00:00Z");

function target(
  identifier: string,
  overrides: Partial<GithubRegistryTarget> = {},
): GithubRegistryTarget {
  return {
    serverId: `server:${identifier}`,
    versionId: `version:${identifier}`,
    identifier,
    name: identifier.split("/").pop() ?? identifier,
    summary: `MCP server ${identifier} from the MCP registry.`,
    description: null,
    endpointUrl: null,
    ...overrides,
  };
}

// The catalog as federation lists it: Notion untitled and fallback-named,
// Netdata titled, plus entries no GitHub row describes.
const notion = target("com.notion/mcp", {
  name: "Notion",
  summary: "MCP server com.notion/mcp from the MCP registry.",
  description: null,
  endpointUrl: "https://mcp.notion.com/mcp",
});
const netdata = target("io.github.netdata/mcp-server", {
  name: "Netdata",
  summary:
    "Real-time infrastructure monitoring with metrics, logs, alerts, and ML-based anomaly detection.",
  description:
    "Real-time infrastructure monitoring with metrics, logs, alerts, and ML-based anomaly detection.",
  endpointUrl: "https://app.netdata.cloud/api/v1/mcp",
});
const lookalike = target("com.example/notion", {
  endpointUrl: "https://mcp.notion.com/mcp",
});
const unrelated = target("io.github.someone/else", {
  endpointUrl: "https://else.example.com/mcp",
});

function deps(
  fetched: GithubRegistryFetchResult,
  targets: GithubRegistryTarget[],
) {
  const write = vi.fn<GithubRegistryEnrichmentDeps["write"]>(
    async () => undefined,
  );
  const record = vi.fn<GithubRegistryEnrichmentDeps["record"]>(
    async () => undefined,
  );
  const listTargets = vi.fn(async () => targets);
  const d: GithubRegistryEnrichmentDeps = {
    fetchServers: async () => fetched,
    listTargets,
    write,
    record,
    now: () => NOW,
  };
  return { deps: d, write, record, listTargets };
}

beforeEach(() => {
  vi.clearAllMocks();
});

test("the real page matches com.notion/mcp by endpoint domain and io.github.* rows by name, and nothing else", () => {
  const matches = matchGithubRegistryRows(FIXTURE_ROWS, [
    notion,
    netdata,
    lookalike,
    unrelated,
  ]);
  assert.deepEqual(
    matches
      .map((match) => [
        match.target.identifier,
        match.row.name,
        match.matchedBy,
      ])
      .sort(),
    [
      ["com.notion/mcp", "makenotion/notion-mcp-server", "endpoint-domain-org"],
      ["io.github.netdata/mcp-server", "io.github.netdata/mcp-server", "name"],
    ],
  );
});

test("a name match wins over an endpoint match for the same entry", () => {
  const rows = parseGithubRegistryPage({
    servers: [
      {
        server: {
          name: "acme/acme-mcp",
          remotes: [{ url: "https://mcp.acme.com/sse" }],
          _meta: {
            "io.modelcontextprotocol.registry/publisher-provided": {
              github: { isInOrganization: true },
            },
          },
        },
      },
      { server: { name: "com.acme/mcp" } },
    ],
  }).rows;
  const matches = matchGithubRegistryRows(rows, [
    target("com.acme/mcp", { endpointUrl: "https://mcp.acme.com/mcp" }),
  ]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.matchedBy, "name");
  assert.equal(matches[0]?.row.name, "com.acme/mcp");
});

test("a pass writes a record per match, patches the manifest where the rules say, and creates nothing", async () => {
  const {
    deps: d,
    write,
    record,
  } = deps({ rows: FIXTURE_ROWS, pages: 1, stoppedBy: null }, [
    notion,
    netdata,
    lookalike,
    unrelated,
  ]);
  const summary = await runGithubRegistryEnrichment(d);

  assert.equal(summary.rows, 9);
  assert.equal(summary.targets, 4);
  assert.deepEqual(summary.matched, { name: 1, endpointDomainOrg: 1 });
  assert.equal(summary.written, 2);
  assert.equal(summary.manifestPatched, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.stoppedBy, null);
  assert.equal(record.mock.calls.length, 1);

  const writes = new Map(
    write.mock.calls.map(([input]) => [input.versionId, input]),
  );
  // Only the two existing entries were written; the GitHub-only rows
  // (microsoft/markitdown, …) created nothing.
  assert.deepEqual([...writes.keys()].sort(), [
    notion.versionId,
    netdata.versionId,
  ]);

  const notionWrite = writes.get(notion.versionId)!;
  assert.equal(notionWrite.serverId, notion.serverId);
  assert.deepEqual(notionWrite.record, {
    name: "makenotion/notion-mcp-server",
    matchedBy: "endpoint-domain-org",
    ownerAvatarUrl: "https://avatars.githubusercontent.com/u/4792552?v=4",
    stars: 4676,
    license: "MIT License",
    displayName: "Notion",
    description: "Official MCP server for Notion API",
    fetchedAt: NOW.toISOString(),
  });
  // Notion had no description: the row's is taken, and the placeholder
  // summary with it. Its displayName equals the fallback name, so the name
  // stays.
  assert.deepEqual(notionWrite.patch, {
    description: "Official MCP server for Notion API",
    summary: "Official MCP server for Notion API",
  });

  const netdataWrite = writes.get(netdata.versionId)!;
  assert.equal(netdataWrite.record.matchedBy, "name");
  assert.equal(netdataWrite.record.stars, 81104);
  assert.equal(netdataWrite.record.license, "GNU General Public License v3.0");
  // Same description on both sides, and a titled entry: no manifest change.
  assert.deepEqual(netdataWrite.patch, {});
});

test("a second pass over the same registry writes the same records and no manifest changes", async () => {
  // The catalog after the first pass: Notion carries the row's description.
  const after = {
    ...notion,
    description: "Official MCP server for Notion API",
    summary: "Official MCP server for Notion API",
  };
  const { deps: d, write } = deps(
    { rows: FIXTURE_ROWS, pages: 1, stoppedBy: null },
    [after, netdata],
  );
  const summary = await runGithubRegistryEnrichment(d);
  assert.equal(summary.written, 2);
  assert.equal(summary.manifestPatched, 0);
  for (const [input] of write.mock.calls) {
    assert.deepEqual(input.patch, {});
  }
});

test("a walk that stopped early still annotates what it read, and says so", async () => {
  const { deps: d, write } = deps(
    {
      rows: FIXTURE_ROWS.slice(0, 2),
      pages: 1,
      stoppedBy: "rate_limited",
      error: "The registry answered 429",
    },
    [notion, netdata],
  );
  const summary = await runGithubRegistryEnrichment(d);
  assert.equal(summary.stoppedBy, "rate_limited");
  assert.equal(summary.error, "The registry answered 429");
  assert.equal(summary.written, 1);
  assert.equal(write.mock.calls.length, 1);
  assert.equal(logs.warn.mock.calls.length, 1);
});

test("a walk that read nothing touches neither the catalog nor its targets", async () => {
  const {
    deps: d,
    write,
    listTargets,
    record,
  } = deps({ rows: [], pages: 1, stoppedBy: "error", error: "fetch failed" }, [
    notion,
  ]);
  const summary = await runGithubRegistryEnrichment(d);
  assert.equal(summary.rows, 0);
  assert.equal(summary.targets, 0);
  assert.equal(listTargets.mock.calls.length, 0);
  assert.equal(write.mock.calls.length, 0);
  assert.equal(record.mock.calls.length, 1);
});

test("a write that fails is counted and does not stop the others", async () => {
  const { deps: d, write } = deps(
    { rows: FIXTURE_ROWS, pages: 1, stoppedBy: null },
    [notion, netdata],
  );
  write.mockRejectedValueOnce(new Error("database is away"));
  const summary = await runGithubRegistryEnrichment(d);
  assert.equal(summary.failed, 1);
  assert.equal(summary.written, 1);
  assert.equal(write.mock.calls.length, 2);
});
