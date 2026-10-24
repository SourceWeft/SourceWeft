import assert from "node:assert/strict";
import { test } from "vitest";
import {
  MCP_SCORE_RULES,
  MCP_SCORE_TOTAL_WEIGHT,
  mcpScoreGrade,
  scoreMcp,
  type McpScoreSource,
} from "./score";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const FRESH = "2026-10-20T00:00:00.000Z";
const STALE = "2026-09-01T00:00:00.000Z";
const LONG_DESCRIPTION =
  "Search, read and update pages, databases and comments in a workspace.";

/** A remote entry federated from the registry, as the catalog stores it. */
function remote(
  manifest: Record<string, unknown> = {},
  provenance: Record<string, unknown> = {},
  source: Partial<McpScoreSource> = {},
): McpScoreSource {
  return {
    manifestJson: {
      schemaVersion: 1,
      identifier: "com.example/mcp",
      transport: "streamable_http",
      endpointUrl: "https://mcp.example.com/mcp",
      summary: "Example",
      tools: [],
      ...manifest,
    },
    provenanceJson: provenance,
    now: NOW,
    ...source,
  };
}

/** A stdio package entry, with no remote endpoint. */
function stdio(
  manifest: Record<string, unknown> = {},
  provenance: Record<string, unknown> = {},
  source: Partial<McpScoreSource> = {},
): McpScoreSource {
  return {
    manifestJson: {
      schemaVersion: 1,
      identifier: "io.github.o/pkg",
      transport: "stdio",
      summary: "Example",
      tools: [],
      ...manifest,
    },
    provenanceJson: provenance,
    now: NOW,
    ...source,
  };
}

function item(source: McpScoreSource, key: string) {
  const found = scoreMcp(source).items.find((entry) => entry.key === key);
  assert.ok(found, `item ${key}`);
  return found;
}

test("the weights sum to 100 so the percentage is the met weight", () => {
  assert.equal(MCP_SCORE_TOTAL_WEIGHT, 100);
  assert.deepEqual(
    MCP_SCORE_RULES.map((rule) => rule.key),
    [
      "reachable",
      "authDeclared",
      "hasTools",
      "hasDescription",
      "hasLogo",
      "hasDocs",
      "hasLicense",
      "officialPublisher",
      "claimed",
    ],
  );
});

test("grade thresholds: 59 F, 60 B, 79 B, 80 A", () => {
  assert.equal(mcpScoreGrade(59), "F");
  assert.equal(mcpScoreGrade(60), "B");
  assert.equal(mcpScoreGrade(79), "B");
  assert.equal(mcpScoreGrade(80), "A");
});

// --- reachable --------------------------------------------------------------

test("reachable: a fresh probe with a classified answer, or a fresh validation", () => {
  for (const result of ["open", "credential", "oauth"]) {
    assert.equal(
      item(remote({}, { authProbe: { result, probedAt: FRESH } }), "reachable")
        .met,
      true,
      result,
    );
  }
  assert.equal(
    item(remote({}, { authProbe: { result: "open", probedAt: STALE } }), "reachable")
      .met,
    false,
    "a probe older than 30 days",
  );
  assert.equal(
    item(remote({}, { authProbe: { result: "open" } }), "reachable").met,
    false,
    "a probe without a time",
  );
  assert.equal(
    item(remote({}, { authProbe: { result: "down", probedAt: FRESH } }), "reachable")
      .met,
    false,
    "an unknown probe result",
  );
  assert.equal(
    item(remote({}, { validatedAt: FRESH }), "reachable").met,
    true,
    "a fresh validation",
  );
  assert.equal(
    item(remote({}, { validatedAt: STALE }), "reachable").met,
    false,
    "a stale validation",
  );
  assert.equal(item(remote(), "reachable").met, false, "nothing stored");
});

test("reachable and authDeclared are required for a remote endpoint only", () => {
  assert.equal(item(remote(), "reachable").required, true);
  assert.equal(item(remote(), "authDeclared").required, true);
  assert.equal(item(stdio(), "reachable").required, false);
  assert.equal(item(stdio(), "authDeclared").required, false);
  assert.equal(
    item(remote({ endpointUrl: "not a url" }), "reachable").required,
    false,
    "a malformed endpoint is not a remote",
  );
});

// --- authDeclared -------------------------------------------------------------

test("authDeclared: any known posture; absent, unknown or malformed is unmet", () => {
  for (const posture of ["none", "optional", "required"]) {
    assert.equal(
      item(remote({ auth: { type: "none", posture } }), "authDeclared").met,
      true,
      posture,
    );
  }
  assert.equal(item(remote({ auth: { type: "oauth" } }), "authDeclared").met, false);
  assert.equal(
    item(remote({ auth: { type: "oauth", posture: "maybe" } }), "authDeclared").met,
    false,
  );
  assert.equal(item(remote({ auth: "oauth" }), "authDeclared").met, false);
  assert.equal(item(remote(), "authDeclared").met, false);
});

// --- hasTools -----------------------------------------------------------------

test("hasTools: at least one tool in the manifest", () => {
  assert.equal(item(remote({ tools: [{ name: "a" }] }), "hasTools").met, true);
  assert.equal(item(remote({ tools: [] }), "hasTools").met, false);
  assert.equal(item(remote({ tools: "many" }), "hasTools").met, false);
  assert.equal(item(remote({ tools: undefined }), "hasTools").met, false);
});

test("hasTools is required only where the server could be listed without a credential", () => {
  const open = remote({}, { authProbe: { result: "open", probedAt: FRESH } });
  assert.equal(item(open, "hasTools").required, true, "an open remote");
  const oauth = remote({}, { authProbe: { result: "oauth", probedAt: FRESH } });
  assert.equal(item(oauth, "hasTools").required, false, "an OAuth remote");
  const credential = remote(
    {},
    { authProbe: { result: "credential", probedAt: FRESH } },
  );
  assert.equal(item(credential, "hasTools").required, false, "a key remote");
  assert.equal(item(remote(), "hasTools").required, false, "never probed");
  assert.equal(
    item(stdio({}, { validatedAt: FRESH }), "hasTools").required,
    true,
    "a validated stdio package",
  );
  assert.equal(
    item(stdio(), "hasTools").required,
    false,
    "a stdio package never validated",
  );
  assert.equal(
    item(
      stdio({}, { validation: { status: "failed", reason: "start", at: FRESH } }),
      "hasTools",
    ).required,
    false,
    "a stdio package that failed validation",
  );
});

test("an authenticated remote without tools is not failed for the tools", () => {
  const score = scoreMcp(
    remote(
      {
        description: LONG_DESCRIPTION,
        auth: { type: "oauth", posture: "required" },
        tools: [],
      },
      { authProbe: { result: "oauth", probedAt: FRESH } },
    ),
  );
  assert.equal(score.grade, "F", "40 % of the weight");
  assert.deepEqual(
    score.items.filter((entry) => entry.required && !entry.met),
    [],
    "but no required item is unmet",
  );
  assert.equal(score.percentage, 40);
});

test("a stdio package without validation and without tools is unmet, not failed", () => {
  const score = scoreMcp(stdio({ description: LONG_DESCRIPTION }));
  const tools = score.items.find((entry) => entry.key === "hasTools")!;
  assert.equal(tools.required, false);
  assert.equal(tools.met, false);
  assert.deepEqual(
    score.items.filter((entry) => entry.required && !entry.met),
    [],
  );
});

// --- hasDescription -----------------------------------------------------------

test("hasDescription: 40 visible characters, an AI overview, and nothing else", () => {
  assert.equal(
    item(remote({ description: "a".repeat(40) }), "hasDescription").met,
    true,
  );
  assert.equal(
    item(remote({ description: "a".repeat(39) }), "hasDescription").met,
    false,
  );
  assert.equal(
    item(remote({ description: `${"a".repeat(20)}\n\n\n${"b".repeat(18)}` }), "hasDescription")
      .met,
    false,
    "whitespace does not count",
  );
  assert.equal(
    item(remote({ summary: "a".repeat(40) }), "hasDescription").met,
    true,
    "the summary counts when the description is absent",
  );
  assert.equal(
    item(remote({ description: "short" }, {}, { hasAiOverview: true }), "hasDescription")
      .met,
    true,
    "an AI overview",
  );
  assert.equal(item(remote({ description: 42 }), "hasDescription").met, false);
  assert.equal(item(remote(), "hasDescription").required, true);
  assert.equal(item(stdio(), "hasDescription").required, true);
});

// --- hasLogo ------------------------------------------------------------------

test("hasLogo: a recorded icon source other than the placeholder, or an icon URL", () => {
  for (const iconSource of [
    "registry",
    "server-info",
    "github-avatar",
    "github-registry",
    "favicon",
  ]) {
    assert.equal(item(remote({ iconSource }), "hasLogo").met, true, iconSource);
  }
  assert.equal(item(remote({ iconSource: "placeholder" }), "hasLogo").met, false);
  assert.equal(
    item(remote({ iconUrl: "https://example.com/icon.png" }), "hasLogo").met,
    true,
    "a stored icon URL",
  );
  assert.equal(
    item(remote({}, {}, { iconUrl: "https://github.com/o.png?size=80" }), "hasLogo")
      .met,
    true,
    "the icon the catalog derived",
  );
  assert.equal(
    item(remote({}, {}, { iconSource: "favicon" }), "hasLogo").met,
    true,
    "the source the catalog resolved",
  );
  assert.equal(
    item(remote({ iconSource: "registry" }, {}, { iconSource: "placeholder" }), "hasLogo")
      .met,
    false,
    "the catalog's placeholder outranks a stale manifest source",
  );
  assert.equal(item(remote({ iconUrl: "icon.png" }), "hasLogo").met, false);
  assert.equal(item(remote(), "hasLogo").met, false);
  assert.equal(item(remote(), "hasLogo").required, false);
});

// --- hasDocs ------------------------------------------------------------------

test("hasDocs: a fetched README or RFC 9728 resource documentation", () => {
  assert.equal(item(remote({}, {}, { readmeStatus: "ok" }), "hasDocs").met, true);
  for (const status of [
    "pending",
    "not_found",
    "too_large",
    "unsupported_host",
    "error",
  ] as const) {
    assert.equal(
      item(remote({}, {}, { readmeStatus: status }), "hasDocs").met,
      false,
      status,
    );
  }
  assert.equal(
    item(
      remote(
        {},
        { authMetadata: { resourceDocumentation: "https://docs.example.com" } },
      ),
      "hasDocs",
    ).met,
    true,
  );
  assert.equal(
    item(remote({}, { authMetadata: { resourceDocumentation: "docs" } }), "hasDocs")
      .met,
    false,
    "a documentation value that is not a URL",
  );
  assert.equal(item(remote(), "hasDocs").met, false);
  assert.equal(item(remote(), "hasDocs").required, false);
});

// --- hasLicense ---------------------------------------------------------------

test("hasLicense: the manifest's license, or the GitHub registry's", () => {
  assert.equal(item(remote({ license: "MIT" }), "hasLicense").met, true);
  assert.equal(item(remote({ license: "  " }), "hasLicense").met, false);
  assert.equal(
    item(remote({}, { githubRegistry: { license: "Apache-2.0" } }), "hasLicense").met,
    true,
  );
  assert.equal(item(remote(), "hasLicense").met, false);
  assert.equal(item(remote(), "hasLicense").required, false);
});

// --- officialPublisher --------------------------------------------------------

test("officialPublisher: the publisher's endpoint match, strictly true", () => {
  assert.equal(
    item(
      remote({
        publisher: { domain: "example.com", source: "registry-namespace", endpointMatch: true },
      }),
      "officialPublisher",
    ).met,
    true,
  );
  assert.equal(
    item(remote({ publisher: { domain: "example.com", endpointMatch: false } }), "officialPublisher")
      .met,
    false,
  );
  assert.equal(
    item(remote({ publisher: { domain: "example.com", endpointMatch: "true" } }), "officialPublisher")
      .met,
    false,
  );
  assert.equal(
    item(
      remote({}, {}, {
        publisher: { domain: "example.com", source: "registry-namespace", endpointMatch: true },
      }),
      "officialPublisher",
    ).met,
    true,
    "the publisher the catalog resolved",
  );
  assert.equal(
    item(
      remote({ publisher: { domain: "example.com", endpointMatch: true } }, {}, { publisher: null }),
      "officialPublisher",
    ).met,
    true,
    "a null resolved publisher falls back to the manifest's",
  );
  assert.equal(item(remote(), "officialPublisher").met, false);
  assert.equal(item(remote(), "officialPublisher").required, false);
});

// --- claimed ------------------------------------------------------------------

test("claimed: only the verified owner claim the read passes in", () => {
  assert.equal(item(remote({}, {}, { claimed: true }), "claimed").met, true);
  assert.equal(item(remote({}, { claim: { verified: true } }), "claimed").met, false);
  assert.equal(item(remote(), "claimed").met, false);
  assert.equal(item(remote(), "claimed").required, false);
});

// --- Defensive reading --------------------------------------------------------

test("absent, null or malformed rows score as nothing met", () => {
  for (const source of [
    { manifestJson: null, provenanceJson: null },
    { manifestJson: undefined, provenanceJson: undefined },
    { manifestJson: "manifest", provenanceJson: [] },
    { manifestJson: { auth: null, tools: null, publisher: 1 }, provenanceJson: { authProbe: "open" } },
  ]) {
    const score = scoreMcp({ ...source, now: NOW });
    assert.equal(score.percentage, 0);
    assert.equal(score.grade, "F");
    assert.equal(score.items.length, 9);
    assert.ok(score.items.every((entry) => !entry.met));
    // Not a remote, never listed: only the description is required.
    assert.deepEqual(
      score.items.filter((entry) => entry.required).map((entry) => entry.key),
      ["hasDescription"],
    );
  }
});

test("the same rows at the same time give the same score", () => {
  const source = remote(
    { description: LONG_DESCRIPTION, tools: [{ name: "a" }] },
    { authProbe: { result: "open", probedAt: FRESH } },
    { readmeStatus: "ok" },
  );
  assert.deepEqual(scoreMcp(source), scoreMcp(source));
});

// --- Grades over whole entries ------------------------------------------------

/** A reachable, declared remote with a description: the 40 % every graded remote starts from. */
function gradedRemote(extra: Record<string, unknown> = {}, source: Partial<McpScoreSource> = {}) {
  return remote(
    {
      description: LONG_DESCRIPTION,
      auth: { type: "none", posture: "none" },
      ...extra,
    },
    { authProbe: { result: "credential", probedAt: FRESH } },
    source,
  );
}

test("grade boundaries over whole entries: 58 F, 60 B, 78 B, 80 A", () => {
  // 40 + logo 8 + docs 10 = 58.
  const f = scoreMcp(gradedRemote({ iconSource: "registry" }, { readmeStatus: "ok" }));
  assert.equal(f.percentage, 58);
  assert.equal(f.grade, "F");
  // 40 + logo 8 + docs 10 + license 7 = 65 would skip 60; 40 + 10 + 10 = 60.
  const b = scoreMcp(
    gradedRemote({
      publisher: { domain: "example.com", endpointMatch: true },
    }, { readmeStatus: "ok" }),
  );
  assert.equal(b.percentage, 60);
  assert.equal(b.grade, "B");
  // 40 + logo 8 + docs 10 + publisher 10 + claimed 10 = 78.
  const b2 = scoreMcp(
    gradedRemote(
      { iconSource: "registry", publisher: { domain: "example.com", endpointMatch: true } },
      { readmeStatus: "ok", claimed: true },
    ),
  );
  assert.equal(b2.percentage, 78);
  assert.equal(b2.grade, "B");
  // 40 + logo 8 + license 7 + tools 15 + docs 10 = 80.
  const a = scoreMcp(
    gradedRemote(
      { iconSource: "registry", license: "MIT", tools: [{ name: "a" }] },
      { readmeStatus: "ok" },
    ),
  );
  assert.equal(a.percentage, 80);
  assert.equal(a.grade, "A");
});

test("a required item unmet is F whatever the percentage", () => {
  // Everything but the description: 90 %.
  const score = scoreMcp(
    remote(
      {
        description: "Notion MCP",
        auth: { type: "oauth", posture: "required" },
        tools: [{ name: "search" }],
        iconSource: "favicon",
        license: "MIT",
        publisher: { domain: "example.com", endpointMatch: true },
      },
      { authProbe: { result: "oauth", probedAt: FRESH } },
      { readmeStatus: "ok", claimed: true },
    ),
  );
  assert.equal(score.percentage, 90);
  assert.equal(score.grade, "F");
});

// --- Fixtures -----------------------------------------------------------------

test("fixture: com.notion/mcp-like — an OAuth remote, no tools, a 26-char description — is F until described or claimed", () => {
  const notion = remote(
    {
      identifier: "com.notion/mcp",
      endpointUrl: "https://mcp.notion.com/mcp",
      summary: "Notion MCP Server (Hosted)",
      description: "Notion MCP Server (Hosted)",
      auth: { type: "oauth", required: true, posture: "required" },
      tools: [],
      iconSource: "favicon",
      publisher: { domain: "notion.com", source: "registry-namespace", endpointMatch: true },
    },
    { authProbe: { result: "oauth", probedAt: FRESH } },
  );
  const score = scoreMcp(notion);
  assert.equal(score.grade, "F");
  assert.deepEqual(
    score.items.filter((entry) => entry.required && !entry.met).map((entry) => entry.key),
    ["hasDescription"],
  );
  assert.equal(
    score.items.find((entry) => entry.key === "hasTools")?.required,
    false,
    "an OAuth remote is not failed for listing no tools",
  );
  // 20 + 10 + 8 + 10 = 48 of the weight is met.
  assert.equal(score.percentage, 48);
  // An AI overview (W4) or an owner description (W7) lifts the requirement.
  assert.equal(scoreMcp({ ...notion, hasAiOverview: true }).grade, "F", "48 % stays F");
  assert.equal(
    scoreMcp({
      ...notion,
      hasAiOverview: true,
      claimed: true,
      readmeStatus: "ok",
    }).grade,
    "B",
    "68 % with the overview, a claim and documentation",
  );
});

test("fixture: an open remote that lists tools, with docs, a logo and a license, is A", () => {
  const score = scoreMcp(
    remote(
      {
        identifier: "com.example/mcp",
        description: LONG_DESCRIPTION,
        auth: { type: "none", required: false, posture: "none" },
        tools: [{ name: "search" }, { name: "read" }],
        iconSource: "registry",
        license: "MIT",
      },
      {
        authProbe: { result: "open", probedAt: FRESH },
        validatedAt: FRESH,
        authMetadata: {},
      },
      { readmeStatus: "ok" },
    ),
  );
  assert.equal(score.grade, "A");
  assert.equal(score.percentage, 80);
  assert.deepEqual(
    score.items.filter((entry) => !entry.met).map((entry) => entry.key),
    ["officialPublisher", "claimed"],
  );
});
