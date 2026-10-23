import assert from "node:assert/strict";
import { test } from "vitest";
import {
  marketMcpManifestSchema,
  type MarketMcpManifest,
} from "@sourceweft/market-contracts";
import { genericFallbackName } from "../federation";
import type { GithubRegistryRow } from "./fetch";
import {
  applyGithubRegistryToManifest,
  githubRegistryManifestPatch,
  githubRegistryRecord,
} from "./manifest";

const NOW = new Date("2026-10-24T03:00:00Z");

const notionRow: GithubRegistryRow = {
  name: "makenotion/notion-mcp-server",
  description: "Official MCP server for Notion API",
  remoteUrl: "https://mcp.notion.com/sse",
  github: {
    displayName: "Notion",
    ownerAvatarUrl: "https://avatars.githubusercontent.com/u/4792552?v=4",
    isInOrganization: true,
    stars: 4676,
    license: "MIT License",
    nameWithOwner: "makenotion/notion-mcp-server",
  },
};

function manifest(
  overrides: Partial<MarketMcpManifest> = {},
): MarketMcpManifest {
  return marketMcpManifestSchema.parse({
    schemaVersion: 1,
    identifier: "com.notion/mcp",
    version: "1.0.0",
    name: "Notion",
    summary: "Connect to Notion",
    description: "Connect to Notion",
    transport: "streamable_http",
    endpointUrl: "https://mcp.notion.com/mcp",
    categories: [],
    ...overrides,
  });
}

const options = (identifier: string) => ({
  fallbackName: genericFallbackName(identifier),
});

test("the record keeps the row's facts, bounded, and the match and fetch time", () => {
  const record = githubRegistryRecord(notionRow, "endpoint-domain-org", NOW);
  assert.deepEqual(record, {
    name: "makenotion/notion-mcp-server",
    matchedBy: "endpoint-domain-org",
    ownerAvatarUrl: "https://avatars.githubusercontent.com/u/4792552?v=4",
    stars: 4676,
    license: "MIT License",
    displayName: "Notion",
    description: "Official MCP server for Notion API",
    fetchedAt: "2026-10-24T03:00:00.000Z",
  });
  // Nothing from the row's GitHub block but the declared fields.
  assert.ok(!("nameWithOwner" in record));
  assert.ok(!("readme" in record));
});

test("a record with no GitHub facts is still a record of the match", () => {
  const record = githubRegistryRecord(
    { name: "io.github.acme/thing", github: { isInOrganization: false } },
    "name",
    NOW,
  );
  assert.deepEqual(record, {
    name: "io.github.acme/thing",
    matchedBy: "name",
    fetchedAt: NOW.toISOString(),
  });
});

test("name rule: displayName replaces a generic-name fallback, never a title or a specific name", () => {
  const record = githubRegistryRecord(
    {
      ...notionRow,
      github: { ...notionRow.github, displayName: "Notion MCP" },
    },
    "endpoint-domain-org",
    NOW,
  );
  // Untitled `com.notion/mcp` was named "Notion" by the fallback.
  assert.equal(
    githubRegistryManifestPatch(
      manifest({
        name: "Notion",
        description: "Official MCP server for Notion API",
      }),
      record,
      options("com.notion/mcp"),
    ).name,
    "Notion MCP",
  );
  // The registry gave a title: the name is the publisher's choice.
  assert.equal(
    githubRegistryManifestPatch(
      manifest({
        name: "Notion Workspace",
        description: "Official MCP server for Notion API",
      }),
      record,
      options("com.notion/mcp"),
    ).name,
    undefined,
  );
  // A specific server name has no fallback to replace.
  assert.equal(
    githubRegistryManifestPatch(
      manifest({
        identifier: "io.github.netdata/netdata-monitoring",
        name: "Netdata Monitoring",
        description: "Official MCP server for Notion API",
      }),
      record,
      options("io.github.netdata/netdata-monitoring"),
    ).name,
    undefined,
  );
  // A displayName equal to the fallback changes nothing.
  assert.equal(
    githubRegistryManifestPatch(
      manifest({
        name: "Notion",
        description: "Official MCP server for Notion API",
      }),
      githubRegistryRecord(notionRow, "endpoint-domain-org", NOW),
      options("com.notion/mcp"),
    ).name,
    undefined,
  );
});

test("description rule: only a longer description is taken, and the summary follows when it was derived", () => {
  const record = githubRegistryRecord(notionRow, "endpoint-domain-org", NOW);
  // Ours is shorter and the summary was its first 500 characters.
  assert.deepEqual(
    githubRegistryManifestPatch(
      manifest({ summary: "Notion", description: "Notion" }),
      record,
      options("com.notion/mcp"),
    ),
    {
      description: "Official MCP server for Notion API",
      summary: "Official MCP server for Notion API",
    },
  );
  // Ours had no description: the summary was the registry placeholder.
  assert.deepEqual(
    githubRegistryManifestPatch(
      manifest({
        summary: "MCP server com.notion/mcp from the MCP registry.",
        description: undefined,
      }),
      record,
      options("com.notion/mcp"),
    ),
    {
      description: "Official MCP server for Notion API",
      summary: "Official MCP server for Notion API",
    },
  );
  // Ours is shorter but its summary was written separately: it stays.
  assert.deepEqual(
    githubRegistryManifestPatch(
      manifest({ summary: "A curated summary", description: "Notion" }),
      record,
      options("com.notion/mcp"),
    ),
    { description: "Official MCP server for Notion API" },
  );
  // Ours is as long or longer: nothing changes.
  assert.deepEqual(
    githubRegistryManifestPatch(
      manifest({ description: "Official MCP server for Notion API" }),
      record,
      options("com.notion/mcp"),
    ),
    {},
  );
  assert.deepEqual(
    githubRegistryManifestPatch(
      manifest({
        description: "The official Notion MCP server, hosted by Notion.",
      }),
      record,
      options("com.notion/mcp"),
    ),
    {},
  );
});

test("applying the rules twice changes nothing the second time", () => {
  const record = githubRegistryRecord(
    {
      ...notionRow,
      github: { ...notionRow.github, displayName: "Notion MCP" },
    },
    "endpoint-domain-org",
    NOW,
  );
  const first = applyGithubRegistryToManifest(
    manifest({ name: "Notion", summary: "Notion", description: "Notion" }),
    record,
    options("com.notion/mcp"),
  );
  assert.equal(first.manifest.name, "Notion MCP");
  assert.equal(
    first.manifest.description,
    "Official MCP server for Notion API",
  );
  assert.deepEqual(first.record, record);
  const second = applyGithubRegistryToManifest(
    first.manifest,
    record,
    options("com.notion/mcp"),
  );
  assert.deepEqual(second.manifest, first.manifest);
  assert.deepEqual(
    githubRegistryManifestPatch(
      first.manifest,
      record,
      options("com.notion/mcp"),
    ),
    {},
  );
});

test("a stored value that is not a record leaves the manifest alone", () => {
  const original = manifest();
  for (const value of [
    undefined,
    null,
    "x",
    { name: "a" },
    { matchedBy: "name" },
  ]) {
    const applied = applyGithubRegistryToManifest(
      original,
      value,
      options("com.notion/mcp"),
    );
    assert.equal(applied.manifest, original);
    assert.equal(applied.record, undefined);
  }
});

test("the manifest rules touch neither icons, tools, auth nor categories", () => {
  const original = manifest({
    iconUrl: "https://example.com/icon.png",
    categories: ["productivity"],
  });
  const applied = applyGithubRegistryToManifest(
    original,
    githubRegistryRecord(notionRow, "endpoint-domain-org", NOW),
    options("com.notion/mcp"),
  );
  assert.equal(applied.manifest.iconUrl, original.iconUrl);
  assert.deepEqual(applied.manifest.tools, original.tools);
  assert.deepEqual(applied.manifest.auth, original.auth);
  assert.deepEqual(applied.manifest.categories, original.categories);
});
