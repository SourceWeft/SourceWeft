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
    ],
  );
  assert.deepEqual(
    MCP_SCORE_RULES.map((rule) => rule.weight),
    [25, 10, 15, 15, 10, 15, 10],
  );
});

test("identity is not scored: no item for the claim or the publisher", () => {
  const keys = scoreMcp(remote()).items.map((entry) => entry.key) as string[];
  assert.equal(keys.includes("claimed"), false);
  assert.equal(keys.includes("officialPublisher"), false);
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
    item(
      remote({}, { authProbe: { result: "open", probedAt: "2026-09-24T12:00:00.001Z" } }),
      "reachable",
    ).met,
    true,
    "just under 30 days, as the probe writer reuses it",
  );
  assert.equal(
    item(
      remote({}, { authProbe: { result: "open", probedAt: "2026-09-24T12:00:00.000Z" } }),
      "reachable",
    ).met,
    false,
    "exactly 30 days: the sync would probe again",
  );
  assert.equal(
    item(
      remote({}, { authProbe: { result: "open", probedAt: "2026-10-25T00:00:00.000Z" } }),
      "reachable",
    ).met,
    false,
    "a time in the future",
  );
  assert.equal(
    item(remote({}, { validatedAt: "2026-10-25T00:00:00.000Z" }), "reachable").met,
    false,
    "a validation in the future",
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

test("authDeclared: a known posture backed by a classified probe or a declared method", () => {
  const classified = { authProbe: { result: "credential", probedAt: STALE } };
  for (const posture of ["none", "optional", "required"]) {
    assert.equal(
      item(remote({ auth: { type: "none", posture } }, classified), "authDeclared").met,
      true,
      `${posture} with a probe, however old`,
    );
  }
  assert.equal(
    item(
      remote({ auth: { type: "none", posture: "optional", methods: [{ type: "header", name: "X-Key" }] } }),
      "authDeclared",
    ).met,
    true,
    "a declared credential header",
  );
  assert.equal(
    item(
      remote({ auth: { type: "none", posture: "required", allowedHeaderNames: ["X-Key"] } }),
      "authDeclared",
    ).met,
    true,
    "declared header names",
  );
  assert.equal(
    item(remote({ auth: { type: "oauth", required: true, posture: "required" } }), "authDeclared").met,
    true,
    "a declared auth type",
  );
  // Federation writes a posture for every remote, so one on its own is the
  // default, not a declaration.
  for (const posture of ["none", "optional", "required"]) {
    assert.equal(
      item(remote({ auth: { type: "none", posture } }), "authDeclared").met,
      false,
      `${posture} alone`,
    );
  }
  assert.equal(
    item(remote({ auth: { type: "oauth" } }, classified), "authDeclared").met,
    false,
    "no posture",
  );
  assert.equal(
    item(remote({ auth: { type: "oauth", posture: "maybe" } }, classified), "authDeclared").met,
    false,
    "an unknown posture",
  );
  assert.equal(item(remote({ auth: "oauth" }, classified), "authDeclared").met, false);
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
  assert.equal(score.grade, "F", "50 % of the weight");
  assert.deepEqual(
    score.items.filter((entry) => entry.required && !entry.met),
    [],
    "but no required item is unmet",
  );
  assert.equal(score.percentage, 50);
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
    item(
      remote({
        description: undefined,
        summary: "MCP server com.example/mcp from the MCP registry.",
      }),
      "hasDescription",
    ).met,
    false,
    "the summary never counts: federation fills it with a placeholder",
  );
  assert.equal(
    item(remote({ description: undefined, summary: "a".repeat(80) }), "hasDescription").met,
    false,
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

// --- Owner corrections --------------------------------------------------------

test("an owner's short description counts: the manifest the read passes carries the layer", () => {
  const owner = (fields: string[]) => ({ source: "owner", fields });
  assert.equal(
    item(
      remote({ description: "Notion MCP", owner: owner(["description"]) }),
      "hasDescription",
    ).met,
    true,
  );
  assert.equal(
    item(remote({ description: "Notion MCP" }), "hasDescription").met,
    false,
    "the same text without the owner's layer",
  );
  assert.equal(
    item(
      remote({ description: "Notion MCP", owner: owner(["summary"]) }),
      "hasDescription",
    ).met,
    false,
    "an owner who corrected another field",
  );
});

test("an owner's documentation link counts as documentation", () => {
  assert.equal(
    item(
      remote({ documentationUrl: "https://docs.example.com/mcp" }),
      "hasDocs",
    ).met,
    true,
  );
  assert.equal(
    item(remote({ documentationUrl: "docs" }), "hasDocs").met,
    false,
  );
});

// --- Applicability: hosted-only entries ---------------------------------------

/** What the registry said of a hosted-only entry: remotes, no package. */
const HOSTED = { registryServer: { remotes: [{ type: "streamable-http" }] } };

test("hasLicense does not apply to a hosted-only entry and leaves the denominator", () => {
  const hosted = scoreMcp(remote({}, HOSTED));
  const license = hosted.items.find((entry) => entry.key === "hasLicense");
  assert.deepEqual(license, {
    key: "hasLicense",
    weight: 10,
    applicable: false,
    required: false,
    met: false,
  });
  // Every other item applies.
  assert.ok(
    hosted.items
      .filter((entry) => entry.key !== "hasLicense")
      .every((entry) => entry.applicable),
  );
});

test("a hosted-only percentage is the met weight over the applicable weight, with no automatic license points", () => {
  const facts = {
    description: LONG_DESCRIPTION,
    auth: { type: "none", posture: "none" },
    iconSource: "registry",
  };
  const probe = { authProbe: { result: "credential", probedAt: FRESH } };
  // 25 + 10 + 15 + 10 = 60 of 100 where the license applies.
  const applicable = scoreMcp(remote(facts, probe));
  assert.equal(applicable.percentage, 60);
  // The same 60 of the 90 that apply: 67, and a license changes nothing.
  const hosted = scoreMcp(remote(facts, { ...probe, ...HOSTED }));
  assert.equal(hosted.percentage, 67);
  assert.equal(
    scoreMcp(remote({ ...facts, license: "MIT" }, { ...probe, ...HOSTED }))
      .percentage,
    67,
    "a license on a hosted-only entry earns nothing",
  );
});

test("delivery that is not known to be hosted-only keeps the license applicable", () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["no registry record at all", {}, {}],
    ["a registry record without remotes", {}, { registryServer: { title: "x" } }],
    [
      "a package beside the remote",
      {},
      {
        registryServer: {
          remotes: [{ type: "streamable-http" }],
          packages: [{ registryType: "npm", identifier: "x" }],
        },
      },
    ],
    [
      "a repository in the registry entry",
      {},
      { ...HOSTED, repository: { url: "https://github.com/acme/x" } },
    ],
    ["a repository on the manifest", { repoUrl: "https://github.com/acme/x" }, HOSTED],
  ];
  for (const [label, manifest, provenance] of cases) {
    assert.equal(
      item(remote(manifest, provenance), "hasLicense").applicable,
      true,
      label,
    );
  }
});

test("a stdio package's license always applies", () => {
  assert.equal(
    item(stdio({}, { registryServer: { remotes: [{}] } }), "hasLicense").applicable,
    true,
  );
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
    assert.equal(score.items.length, 7);
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

/** A reachable, declared remote with a description: the 50 % every graded remote starts from. */
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

test("grade boundaries over whole entries: 50 F, 60 B, 75 B, 80 A", () => {
  const f = scoreMcp(gradedRemote());
  assert.equal(f.percentage, 50);
  assert.equal(f.grade, "F");
  // 50 + logo 10 = 60.
  const b = scoreMcp(gradedRemote({ iconSource: "registry" }));
  assert.equal(b.percentage, 60);
  assert.equal(b.grade, "B");
  // 50 + logo 10 + tools 15 = 75.
  const b2 = scoreMcp(
    gradedRemote({ iconSource: "registry", tools: [{ name: "a" }] }),
  );
  assert.equal(b2.percentage, 75);
  assert.equal(b2.grade, "B");
  // 50 + tools 15 + docs 15 = 80.
  const a = scoreMcp(
    gradedRemote({ tools: [{ name: "a" }] }, { readmeStatus: "ok" }),
  );
  assert.equal(a.percentage, 80);
  assert.equal(a.grade, "A");
});

test("a required item unmet is F whatever the percentage", () => {
  // Everything but the description: 85 %.
  const score = scoreMcp(
    remote(
      {
        description: "Notion MCP",
        auth: { type: "oauth", posture: "required" },
        tools: [{ name: "search" }],
        iconSource: "favicon",
        license: "MIT",
      },
      { authProbe: { result: "oauth", probedAt: FRESH } },
      { readmeStatus: "ok" },
    ),
  );
  assert.equal(score.percentage, 85);
  assert.equal(score.grade, "F");
});

// --- Fixtures -----------------------------------------------------------------

const NOTION = remote(
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
  { authProbe: { result: "oauth", probedAt: FRESH }, ...HOSTED },
);

test("fixture: com.notion/mcp-like — a hosted OAuth remote, no tools, a 26-char description — is F until described", () => {
  const score = scoreMcp(NOTION);
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
  // The license does not apply to a hosted service: 25 + 10 + 10 = 45 of 90.
  assert.equal(score.items.find((entry) => entry.key === "hasLicense")?.applicable, false);
  assert.equal(score.percentage, 50);
  // An AI overview (W4) or an owner description (W7) lifts the requirement
  // (60 of 90), and documentation lifts the percentage (75 of 90).
  assert.equal(scoreMcp({ ...NOTION, hasAiOverview: true }).percentage, 67);
  assert.equal(scoreMcp({ ...NOTION, hasAiOverview: true }).grade, "B");
  const described = scoreMcp({ ...NOTION, hasAiOverview: true, readmeStatus: "ok" });
  assert.equal(described.percentage, 83);
  assert.equal(described.grade, "A");
});

test("fixture: arcmira-like — an io.github remote with a repository — scores its data, not who published it", () => {
  const arcmira = remote(
    {
      identifier: "io.github.arcmira/mcp",
      endpointUrl: "https://mcp.arcmira.com/mcp",
      description: LONG_DESCRIPTION,
      auth: { type: "api_key_header", required: true, posture: "required", headerName: "X-Api-Key" },
      iconSource: "github",
      repoUrl: "https://github.com/arcmira/mcp",
    },
    { authProbe: { result: "credential", probedAt: FRESH }, ...HOSTED },
    { readmeStatus: "ok" },
  );
  // reachable 25 + auth 10 + description 15 + logo 10 + docs 15; the license
  // applies (a repository is delivered) and is unmet.
  const score = scoreMcp(arcmira);
  assert.equal(score.percentage, 75);
  assert.equal(score.grade, "B");
  // Neither a domain publisher nor a claim changes the number.
  const identified = scoreMcp({
    ...arcmira,
    manifestJson: {
      ...(arcmira.manifestJson as Record<string, unknown>),
      publisher: { domain: "arcmira.com", source: "registry-namespace", endpointMatch: true },
    },
  });
  assert.deepEqual(identified, score);
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
  assert.equal(score.percentage, 100);
  assert.deepEqual(
    score.items.filter((entry) => !entry.met).map((entry) => entry.key),
    [],
  );
});

test("fixture: a validated stdio package requires its tools and has a license to declare", () => {
  const pkg = stdio(
    { description: LONG_DESCRIPTION, license: "MIT" },
    {
      validatedAt: FRESH,
      registryServer: { packages: [{ registryType: "npm", identifier: "x" }] },
    },
  );
  const score = scoreMcp(pkg);
  const tools = score.items.find((entry) => entry.key === "hasTools");
  assert.equal(tools?.required, true);
  assert.equal(tools?.met, false);
  assert.equal(score.grade, "F");
  const license = score.items.find((entry) => entry.key === "hasLicense");
  assert.deepEqual([license?.applicable, license?.met], [true, true]);
});
