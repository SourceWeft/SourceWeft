import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  storedProbes: vi.fn(
    async (_versionIds: string[]) =>
      new Map<
        string,
        {
          authProbe?: unknown;
          toolsListing?: unknown;
          tools?: unknown;
          selfDescription?: unknown;
          authMetadata?: unknown;
          serverCard?: unknown;
        }
      >(),
  ),
  storedIconProvenance: vi.fn(
    async (_versionIds: string[]) =>
      new Map<
        string,
        {
          selfDescription?: unknown;
          githubRegistry?: unknown;
          iconProbe?: unknown;
        }
      >(),
  ),
  // The favicon step's storage, injected so no test depends on the ambient
  // PUBLIC_S3_* environment (the test setup loads dotenv).
  storeConfigured: false,
  storeIcon: vi.fn(
    async (input: { domain: string; bytes: Buffer; contentType: string }) => ({
      url: `https://assets.test/market/mcp-icons/${input.domain}/stored.png`,
    }),
  ),
  // The icon dry-run step (Issue #367) is covered by its own tests; here it
  // only has to hand its provenance to the upsert and never change the icon.
  iconDryRun: vi.fn(
    async (
      _entries: unknown[],
      _now: Date,
    ): Promise<{
      provenance: Map<string, { iconCandidates?: unknown; iconDecision?: unknown }>;
      counts: Record<string, number>;
    }> => ({
      provenance: new Map(),
      counts: {
        entries: 0,
        collected: 0,
        reused: 0,
        skipped: 0,
        failed: 0,
        sitesScraped: 0,
        candidatesAccepted: 0,
        picks: 0,
        placeholders: 0,
        differs: 0,
      },
    }),
  ),
}));

vi.mock("./icons/federation-step", () => ({
  registryIconDryRun: mocks.iconDryRun,
}));

vi.mock("./icons/store", () => ({
  canStoreMcpIcons: () => mocks.storeConfigured,
  storeMcpIcon: mocks.storeIcon,
}));
vi.mock("./ingest/repository", () => ({
  upsertMarketMcp: mocks.upsert,
  findStoredEndpointProbes: mocks.storedProbes,
  findStoredIconProvenance: mocks.storedIconProvenance,
}));
vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import {
  authProbeRecord,
  DEFAULT_REGISTRY_PAGE_RETRY,
  endpointProbeRecord,
  federateRegistryEntry,
  ingestFromRegistry,
  mapRegistryServerToManifest,
  registryRemoteAuth,
  registryRepositoryProvenance,
  runMarketFederation,
  storedAuthProbe,
  storedProbePieces,
  storedToolsListing,
  toolsListingRecord,
} from "./federation";
import { mcpServerVersionId } from "./ingest/plan";

function serverEntry(id: number) {
  return {
    server: {
      name: `io.github.acme/server-${id}`,
      version: "1.0.0",
      description: `Server ${id}`,
      remotes: [{ type: "streamable-http", url: `https://acme.test/${id}` }],
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.storeConfigured = false;
});

test("a mid-pagination fetch failure keeps the partial run instead of discarding it", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  // Page 1 succeeds and points to a next cursor; page 2 fails on every retry.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      if (!url.searchParams.get("cursor")) {
        return new Response(
          JSON.stringify({
            servers: [serverEntry(1), serverEntry(2)],
            metadata: { nextCursor: "page-2" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new TypeError("fetch failed");
    }),
  );

  const result = await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
    retry: noWaitRetry(3),
  });

  // The two page-1 servers were upserted and must be reported, not lost.
  assert.equal(result.ingested, 2);
  assert.equal(result.partial, true);
  assert.ok(result.error?.includes("fetch failed"));
  assert.equal(mocks.upsert.mock.calls.length, 2);
  // Where to resume from: the page that could not be read.
  assert.equal(result.nextCursor, "page-2");
  const pageRequests = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
    ([input]) => String(input).includes("/v0/servers"),
  );
  // One request for page 1, then every attempt at page 2.
  assert.equal(pageRequests.length, 1 + 3);
});

/** A page retry policy that does not wait between attempts. */
function noWaitRetry(attempts: number) {
  return { attempts, delayMs: () => 0 };
}

test("the default page retry backs off exponentially and is bounded", () => {
  assert.equal(DEFAULT_REGISTRY_PAGE_RETRY.attempts, 6);
  assert.deepEqual(
    [2, 3, 4, 5, 6].map((attempt) =>
      DEFAULT_REGISTRY_PAGE_RETRY.delayMs(attempt),
    ),
    [1000, 2000, 4000, 8000, 16000],
  );
  assert.equal(DEFAULT_REGISTRY_PAGE_RETRY.delayMs(10), 30_000);
});

test("a page that fails once is retried and the walk completes", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  let page2Attempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      const cursor = url.searchParams.get("cursor");
      if (cursor === "page-2" && page2Attempts++ === 0) {
        throw new TypeError("fetch failed");
      }
      const body = cursor
        ? { servers: [serverEntry(3)], metadata: { nextCursor: null } }
        : {
            servers: [serverEntry(1), serverEntry(2)],
            metadata: { nextCursor: "page-2" },
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );

  const result = await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
    retry: noWaitRetry(3),
  });

  assert.equal(result.ingested, 3);
  assert.equal(result.partial, false);
  assert.equal(result.nextCursor, undefined);
  assert.equal(page2Attempts, 2);
});

test("a run resumes from the cursor of a partial run", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input);
    assert.equal(url.searchParams.get("cursor"), "page-2");
    return new Response(
      JSON.stringify({
        servers: [serverEntry(3)],
        metadata: { nextCursor: null },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetch);

  const result = await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
    cursor: "page-2",
  });

  assert.equal(result.ingested, 1);
  assert.equal(result.partial, false);
  assert.equal(
    fetch.mock.calls.filter(([input]) => String(input).includes("/v0/servers"))
      .length,
    1,
  );
});

test("runMarketFederation resumes a partial walk from its cursor instead of starting over", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  let page2Requests = 0;
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input);
    const cursor = url.searchParams.get("cursor");
    // Page 2 fails every attempt the first time it is asked for, then works.
    if (cursor === "page-2" && page2Requests++ < 2) {
      throw new TypeError("fetch failed");
    }
    const body = cursor
      ? { servers: [serverEntry(3)], metadata: { nextCursor: null } }
      : {
          servers: [serverEntry(1), serverEntry(2)],
          metadata: { nextCursor: "page-2" },
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);

  const [result] = await runMarketFederation(
    [
      {
        source: "registry.test",
        baseUrl: "https://registry.test",
        verified: true,
      },
    ],
    { retry: noWaitRetry(2), resume: { maxResumes: 3, delayMs: 0 } },
  );

  assert.equal(result?.ingested, 3);
  assert.equal(result?.partial, false);
  assert.equal(result?.resumes, 1);
  // Page 1 was read once: the resume started at page 2.
  const pageOneRequests = fetch.mock.calls.filter(
    ([input]) =>
      String(input).includes("/v0/servers") &&
      !new URL(String(input)).searchParams.get("cursor"),
  );
  assert.equal(pageOneRequests.length, 1);
  assert.equal(mocks.upsert.mock.calls.length, 3);
});

test("runMarketFederation gives up after the resume budget and reports the partial walk", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.searchParams.get("cursor")) throw new TypeError("fetch failed");
      return new Response(
        JSON.stringify({
          servers: [serverEntry(1)],
          metadata: { nextCursor: "page-2" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );

  const [result] = await runMarketFederation(
    [
      {
        source: "registry.test",
        baseUrl: "https://registry.test",
        verified: true,
      },
    ],
    { retry: noWaitRetry(1), resume: { maxResumes: 2, delayMs: 0 } },
  );

  assert.equal(result?.partial, true);
  assert.equal(result?.resumes, 2);
  assert.equal(result?.nextCursor, "page-2");
  // Page 1 was ingested once; the resumes never re-read it.
  assert.equal(result?.ingested, 1);
});

test("federateRegistryEntry federates the latest version of one identifier, now", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === "/v0/servers") {
      assert.equal(url.searchParams.get("search"), "io.github.acme/server-7");
      assert.equal(url.searchParams.get("version"), "latest");
      return new Response(
        JSON.stringify({
          servers: [
            // The search is a text match: a neighbour, an old version, the one.
            serverEntry(70),
            {
              ...serverEntry(7),
              _meta: {
                "io.modelcontextprotocol.registry/official": {
                  isLatest: false,
                },
              },
            },
            serverEntry(7),
          ],
          metadata: { count: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // The endpoint probe: an open server.
    assert.equal(init?.method, "POST");
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);

  const result = await federateRegistryEntry({
    identifier: "io.github.acme/server-7",
    source: {
      source: "registry.test",
      baseUrl: "https://registry.test",
      verified: true,
    },
  });

  assert.equal(result.found, true);
  assert.equal(result.ingested, 1);
  assert.equal(mocks.upsert.mock.calls.length, 1);
  const [{ manifest, provenanceJson }] = mocks.upsert.mock.calls[0]!;
  assert.equal(manifest.identifier, "io.github.acme/server-7");
  assert.equal(manifest.verified, true);
  assert.equal(provenanceJson.source, "registry.test");
});

test("federateRegistryEntry reports an identifier the registry does not have", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ servers: [serverEntry(70)] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );

  const result = await federateRegistryEntry({
    identifier: "io.github.acme/server-7",
    source: {
      source: "registry.test",
      baseUrl: "https://registry.test",
      verified: true,
    },
  });

  assert.equal(result.found, false);
  assert.equal(result.ingested, 0);
  assert.equal(mocks.upsert.mock.calls.length, 0);
});

test("registry entries are categorized from their text, not left empty", async () => {
  const manifest = mapRegistryServerToManifest(
    {
      server: {
        name: "io.github.acme/postgres-mcp",
        title: "Postgres MCP",
        version: "1.0.0",
        description: "Query and manage a PostgreSQL database over SQL.",
        remotes: [{ type: "streamable-http", url: "https://acme.test/pg" }],
      },
    },
    { verified: true },
  );
  assert.ok(manifest);
  assert.ok(manifest.categories.length > 0);
  assert.ok(manifest.categories.includes("databases"));
});

function nameFor(name: string, title?: string) {
  return mapRegistryServerToManifest(
    {
      server: {
        name,
        title,
        version: "1.0.0",
        remotes: [{ type: "streamable-http", url: "https://acme.test/mcp" }],
      },
    },
    { verified: true },
  )?.name;
}

test("an untitled entry with a generic name is named after its namespace", () => {
  // Notion's official entry has no title: it was listed as "Mcp".
  assert.equal(nameFor("com.notion/mcp"), "Notion");
  assert.equal(nameFor("ai.smithery/server"), "Smithery");
  assert.equal(nameFor("io.github.acme-labs/mcp-server"), "Acme Labs");
  assert.equal(nameFor("io.github.acme/MCP"), "Acme");
});

test("a title, or a specific name, is kept as the display name", () => {
  assert.equal(nameFor("com.notion/mcp", "Notion MCP"), "Notion MCP");
  assert.equal(nameFor("io.github.acme/postgres-mcp"), "Postgres Mcp");
  assert.equal(nameFor("io.github.acme/weather"), "Weather");
});

test("registry entries preserve the first valid HTTPS icon", () => {
  const manifest = mapRegistryServerToManifest(
    {
      server: {
        name: "io.github.acme/icon-mcp",
        version: "1.0.0",
        icons: [
          { src: "http://insecure.test/icon.png" },
          { src: "https://cdn.acme.test/icon.png" },
        ],
        remotes: [{ type: "streamable-http", url: "https://acme.test/mcp" }],
      },
    },
    { verified: true },
  );
  assert.equal(manifest?.iconUrl, "https://cdn.acme.test/icon.png");
});

test("a clean walk to the end reports the full count and is not partial", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      const cursor = url.searchParams.get("cursor");
      const body = cursor
        ? { servers: [serverEntry(3)], metadata: { nextCursor: null } }
        : {
            servers: [serverEntry(1), serverEntry(2)],
            metadata: { nextCursor: "page-2" },
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );

  const result = await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
  });

  assert.equal(result.ingested, 3);
  assert.equal(result.partial, false);
  assert.equal(result.error, undefined);
});

test("the registry's repository, subfolder included, is kept in provenance", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  // The two real registry entries the README fetch was designed against.
  const entries = [
    {
      server: {
        name: "io.github.prakhar1605/carrerlift",
        version: "1.0.0",
        description: "Career tools",
        repository: {
          url: "https://github.com/prakhar1605/carrerlift-mcp",
          source: "github",
        },
      },
    },
    {
      server: {
        name: "io.github.FTHTrading/genesis402-mcp",
        version: "0.2.0",
        description: "Genesis402 agent kit",
        repository: {
          url: "https://github.com/FTHTrading/genesis402-agent-kit",
          source: "github",
          subfolder: "mcp",
          unknownField: { nested: true },
        },
      },
    },
  ];
  // The registry page; the endpoints answer nothing.
  stubRegistryAndEndpoints(entries, () => new Response(null, { status: 404 }));

  await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
  });

  const provenance = mocks.upsert.mock.calls.map(
    ([input]) => input.provenanceJson,
  );
  assert.deepEqual(provenance[0].repository, {
    url: "https://github.com/prakhar1605/carrerlift-mcp",
    source: "github",
  });
  assert.deepEqual(provenance[1].repository, {
    url: "https://github.com/FTHTrading/genesis402-agent-kit",
    source: "github",
    subfolder: "mcp",
  });
  // Upserts never carry README state: a new version starts `pending` by the
  // column defaults, and a re-sync leaves a stored README alone.
  for (const [input] of mocks.upsert.mock.calls) {
    assert.equal("readme" in input, false);
  }
});

test("the registry's packages and remotes are kept in provenance by name and flags, never by value", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const entries = [
    {
      server: {
        name: "io.github.FTHTrading/genesis402-mcp",
        version: "0.2.0",
        description: "179 x402 pay-per-call APIs",
        packages: [
          {
            registryType: "npm",
            identifier: "genesis402-mcp",
            version: "0.2.0",
            transport: { type: "stdio" },
            runtimeArguments: [{ name: "--token", value: "arg-secret" }],
            environmentVariables: [
              {
                name: "GENESIS402_PAYER_KEY",
                description: "Private key of a Base wallet holding USDC.",
                isSecret: true,
                value: "0xdeadbeef-private-key",
                default: "0xdefault-private-key",
                placeholder: "0x...",
              },
            ],
          },
        ],
      },
    },
    {
      server: {
        name: "io.github.prakhar1605/carrerlift",
        version: "1.0.0",
        description: "Jobs",
        remotes: [
          {
            type: "streamable-http",
            url: "https://www.carrerlift.in/api/mcp?key=query-secret",
            headers: [
              { name: "Authorization", isRequired: true, value: "Bearer x" },
            ],
          },
        ],
      },
    },
    {
      server: { name: "io.github.acme/bare", version: "1.0.0" },
    },
  ];
  // The registry page; the endpoints answer nothing.
  stubRegistryAndEndpoints(entries, () => new Response(null, { status: 404 }));

  await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
  });

  const provenance = mocks.upsert.mock.calls.map(
    ([input]) => input.provenanceJson,
  );
  assert.deepEqual(provenance[0].registryServer, {
    packages: [
      {
        registryType: "npm",
        identifier: "genesis402-mcp",
        version: "0.2.0",
        transport: { type: "stdio" },
        environmentVariables: [
          {
            name: "GENESIS402_PAYER_KEY",
            description: "Private key of a Base wallet holding USDC.",
            isSecret: true,
          },
        ],
        // The argument is kept by name for the stdio validation's command;
        // its value is an input and is not.
        runtimeArguments: [{ name: "--token" }],
      },
    ],
  });
  assert.deepEqual(provenance[1].registryServer, {
    remotes: [
      {
        type: "streamable-http",
        url: "https://www.carrerlift.in/api/mcp",
        headers: [{ name: "Authorization", isRequired: true }],
      },
    ],
  });
  assert.equal(provenance[2].registryServer, undefined);
  const stored = JSON.stringify(provenance);
  for (const secret of [
    "0xdeadbeef",
    "0xdefault",
    "arg-secret",
    "query-secret",
    "Bearer x",
  ]) {
    assert.equal(stored.includes(secret), false, secret);
  }
});

test("an entry without a repository keeps none", () => {
  assert.equal(
    registryRepositoryProvenance({ server: { name: "x", version: "1" } }),
    undefined,
  );
  assert.equal(
    registryRepositoryProvenance({
      server: { name: "x", version: "1", repository: null },
    }),
    undefined,
  );
});

// Issue #337: the Arcmira listing as the registry publishes it — an optional,
// secret Authorization header, and an endpoint that answers an
// unauthenticated initialize with an OAuth challenge.
const ARCMIRA_ENDPOINT = "https://mcp.arcmira.com/mcp";
const arcmiraEntry = {
  server: {
    name: "io.github.arcmira/arcmira",
    title: "Arcmira: YouTube Transcript Search",
    version: "0.10.7",
    description:
      "Search YouTube transcripts for timestamps, speaker appearances, sponsors and recommendations.",
    remotes: [
      {
        type: "streamable-http",
        url: ARCMIRA_ENDPOINT,
        headers: [
          {
            name: "Authorization",
            isSecret: true,
            description:
              "Bearer <key>. Omit the header and the host signs you in through OAuth.",
          },
        ],
      },
    ],
  },
  _meta: {
    "io.modelcontextprotocol.registry/official": { isLatest: true },
  },
};

function requestUrl(input: unknown) {
  return input instanceof Request ? input.url : String(input);
}

/** A registry page with `entries`, and `endpoint` for every other URL. */
function stubRegistryAndEndpoints(
  entries: unknown[],
  endpoint: (url: string) => Response | Promise<Response>,
) {
  const fetch = vi.fn(async (input: unknown) => {
    const url = requestUrl(input);
    if (url.startsWith("https://registry.test/")) {
      return new Response(
        JSON.stringify({ servers: entries, metadata: { nextCursor: null } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return endpoint(url);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function oauthChallenge() {
  return new Response(JSON.stringify({ error: "no credential" }), {
    status: 401,
    headers: {
      "www-authenticate":
        'Bearer resource_metadata="https://mcp.arcmira.com/.well-known/oauth-protected-resource"',
    },
  });
}

function endpointCalls(fetch: ReturnType<typeof vi.fn>) {
  return fetch.mock.calls.filter(
    ([input]) => !requestUrl(input).startsWith("https://registry.test/"),
  );
}

/** The `initialize` probes of Arcmira's endpoint itself. */
function initializeCalls(fetch: ReturnType<typeof vi.fn>) {
  return fetch.mock.calls.filter(
    ([input]) => requestUrl(input) === ARCMIRA_ENDPOINT,
  );
}

const authorization = { name: "Authorization", isSecret: true };
const remote = (headers: unknown[]) => ({
  type: "streamable-http",
  url: "https://acme.test/mcp",
  headers,
});

test("registry auth: an OAuth challenge with a declared Authorization header is OAuth or API key", () => {
  assert.deepEqual(registryRemoteAuth(remote([authorization]), "oauth"), {
    type: "oauth",
    required: true,
    headerName: "Authorization",
    allowedHeaderNames: ["Authorization"],
    posture: "required",
    methods: [
      { type: "oauth" },
      { type: "header", name: "Authorization", scheme: "bearer" },
    ],
  });
});

test("registry auth: an OAuth challenge without a credential header is OAuth only", () => {
  assert.deepEqual(registryRemoteAuth(remote([]), "oauth"), {
    type: "oauth",
    required: true,
    headerName: undefined,
    allowedHeaderNames: [],
    posture: "required",
    methods: [{ type: "oauth" }],
  });
  // A non-secret header is configuration, not an alternative credential.
  assert.equal(
    registryRemoteAuth(remote([{ name: "X-Region" }]), "oauth").headerName,
    undefined,
  );
  // A secret header other than Authorization is the API-key alternative.
  assert.equal(
    registryRemoteAuth(remote([{ name: "X-Api-Key", isSecret: true }]), "oauth")
      .headerName,
    "X-Api-Key",
  );
});

test("registry auth: a bare 401 is the declared credential, or OAuth when none is declared", () => {
  assert.deepEqual(registryRemoteAuth(remote([authorization]), "credential"), {
    type: "bearer",
    required: true,
    headerName: "Authorization",
    displayName: "Authorization token",
    allowedHeaderNames: ["Authorization"],
    posture: "required",
    methods: [{ type: "header", name: "Authorization", scheme: "bearer" }],
  });
  assert.deepEqual(
    registryRemoteAuth(
      remote([{ name: "X-Api-Key", isSecret: true }]),
      "credential",
    ),
    {
      type: "api_key_header",
      required: true,
      headerName: "X-Api-Key",
      displayName: "X-Api-Key",
      allowedHeaderNames: ["X-Api-Key"],
      posture: "required",
      methods: [{ type: "header", name: "X-Api-Key" }],
    },
  );
  assert.equal(registryRemoteAuth(remote([]), "credential").type, "oauth");
});

test("registry auth: an open endpoint is required only by a header declared required", () => {
  const optional = registryRemoteAuth(remote([authorization]), "open");
  assert.deepEqual(optional, {
    type: "none",
    required: false,
    allowedHeaderNames: [],
    posture: "optional",
    methods: [{ type: "header", name: "Authorization", scheme: "bearer" }],
  });
  const required = registryRemoteAuth(
    remote([
      { name: "X-Api-Key", isRequired: true, isSecret: true },
      { name: "X-Org", isRequired: true },
    ]),
    "open",
  );
  assert.deepEqual(required, {
    type: "custom_headers",
    required: true,
    headerName: undefined,
    displayName: "Custom headers",
    allowedHeaderNames: ["X-Api-Key", "X-Org"],
    posture: "required",
    methods: [{ type: "header", name: "X-Api-Key" }],
  });
});

test("registry auth: without a probe, only the declared flags count", () => {
  assert.equal(
    registryRemoteAuth(remote([authorization]), undefined).type,
    "none",
  );
  assert.deepEqual(
    registryRemoteAuth(
      remote([{ ...authorization, isRequired: true }]),
      undefined,
    ),
    {
      type: "bearer",
      required: true,
      headerName: "Authorization",
      displayName: "Authorization token",
      allowedHeaderNames: ["Authorization"],
      posture: "required",
      methods: [{ type: "header", name: "Authorization", scheme: "bearer" }],
    },
  );
  assert.equal(registryRemoteAuth(undefined, undefined).type, "none");
});

test("registry auth: Arcmira's optional secret Authorization behind an OAuth challenge", () => {
  const auth = registryRemoteAuth(arcmiraEntry.server.remotes[0], "oauth");
  assert.equal(auth.type, "oauth");
  assert.equal(auth.posture, "required");
  assert.deepEqual(auth.methods, [
    { type: "oauth" },
    {
      type: "header",
      name: "Authorization",
      scheme: "bearer",
      description:
        "Bearer <key>. Omit the header and the host signs you in through OAuth.",
    },
  ]);
});

test("registry auth: an open endpoint with an optional secret key is optional and installs as none", () => {
  // Exa-like: works without a key, takes one in `x-api-key`.
  const auth = registryRemoteAuth(
    remote([
      {
        name: "x-api-key",
        isSecret: true,
        description: "  Your Exa API key for higher rate limits.  ",
      },
    ]),
    "open",
  );
  assert.deepEqual(auth, {
    type: "none",
    required: false,
    allowedHeaderNames: [],
    posture: "optional",
    methods: [
      {
        type: "header",
        name: "x-api-key",
        description: "Your Exa API key for higher rate limits.",
      },
    ],
  });
});

test("registry auth: posture and methods across probes and declared headers", () => {
  const cases: Array<{
    headers: unknown[];
    probe: "open" | "credential" | "oauth" | undefined;
    posture: string;
    methods: unknown[];
  }> = [
    { headers: [], probe: undefined, posture: "none", methods: [] },
    { headers: [], probe: "open", posture: "none", methods: [] },
    {
      headers: [],
      probe: "credential",
      posture: "required",
      methods: [{ type: "oauth" }],
    },
    // A non-secret header is configuration, never a method.
    {
      headers: [{ name: "X-Region" }],
      probe: "open",
      posture: "none",
      methods: [],
    },
    {
      headers: [{ name: "X-Region", isRequired: true }],
      probe: "open",
      posture: "required",
      methods: [],
    },
    {
      headers: [{ name: "X-Region" }],
      probe: "credential",
      posture: "required",
      methods: [],
    },
    {
      headers: [{ name: "X-Api-Key", isSecret: true }],
      probe: undefined,
      posture: "optional",
      methods: [{ type: "header", name: "X-Api-Key" }],
    },
    {
      headers: [{ name: "X-Api-Key", isSecret: true }],
      probe: "oauth",
      posture: "required",
      methods: [{ type: "oauth" }, { type: "header", name: "X-Api-Key" }],
    },
    // Authorization wins over an earlier secret header, in any spelling.
    {
      headers: [
        { name: "X-Api-Key", isSecret: true },
        { name: "authorization" },
      ],
      probe: "open",
      posture: "optional",
      methods: [{ type: "header", name: "authorization", scheme: "bearer" }],
    },
  ];
  for (const { headers, probe, posture, methods } of cases) {
    const auth = registryRemoteAuth(remote(headers), probe);
    const label = `${JSON.stringify(headers)} / ${probe}`;
    assert.equal(auth.posture, posture, label);
    assert.deepEqual(auth.methods, methods, label);
  }
  // An optional posture never blocks an install.
  for (const probe of ["open", undefined] as const) {
    assert.equal(
      registryRemoteAuth(remote([authorization]), probe).type,
      "none",
    );
  }
});

test("registry auth: a method's description is the header's, trimmed to 300 characters", () => {
  const [method] = registryRemoteAuth(
    remote([{ ...authorization, description: ` ${"k".repeat(400)} ` }]),
    "open",
  ).methods!;
  assert.deepEqual(method, {
    type: "header",
    name: "Authorization",
    scheme: "bearer",
    description: "k".repeat(300),
  });
  assert.deepEqual(
    registryRemoteAuth(
      remote([{ ...authorization, description: "   " }]),
      "open",
    ).methods,
    [{ type: "header", name: "Authorization", scheme: "bearer" }],
  );
});

test("registry auth: malformed and duplicate header names are dropped", () => {
  const auth = registryRemoteAuth(
    remote([
      { name: "Bad Header", isRequired: true },
      { name: "authorization", isSecret: true },
      { name: "Authorization", isSecret: true },
      null,
      "Authorization",
    ]),
    "credential",
  );
  assert.equal(auth.type, "bearer");
  assert.deepEqual(auth.allowedHeaderNames, ["authorization"]);
});

test("issue #337: Arcmira is federated as OAuth or API key, and the probe is stored", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const startedAt = Date.now();
  const fetch = stubRegistryAndEndpoints([arcmiraEntry], () =>
    oauthChallenge(),
  );

  const result = await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
  });

  assert.equal(result.ingested, 1);
  assert.equal(result.authProbed, 1);
  assert.equal(result.authProbeFailed, 0);
  const [probe] = endpointCalls(fetch);
  assert.ok(probe);
  const request = probe[0] as Request;
  assert.equal(request.url, ARCMIRA_ENDPOINT);
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("authorization"), null);
  assert.equal((await request.json()).method, "initialize");

  const input = mocks.upsert.mock.calls[0]?.[0];
  assert.ok(input);
  assert.deepEqual(input.manifest.auth, {
    type: "oauth",
    required: true,
    headerName: "Authorization",
    allowedHeaderNames: ["Authorization"],
    posture: "required",
    methods: [
      { type: "oauth" },
      {
        type: "header",
        name: "Authorization",
        scheme: "bearer",
        description:
          "Bearer <key>. Omit the header and the host signs you in through OAuth.",
      },
    ],
  });
  const probedAt = new Date(input.provenanceJson.authProbe.probedAt);
  assert.ok(
    probedAt.getTime() >= startedAt && probedAt.getTime() <= Date.now(),
  );
  assert.deepEqual(
    input.provenanceJson.authProbe,
    authProbeRecord(ARCMIRA_ENDPOINT, "oauth", probedAt),
  );
  assert.equal(input.provenanceJson.authProbe.endpointSha256.length, 64);
  assert.equal(
    JSON.stringify(input.provenanceJson.authProbe).includes("arcmira.com"),
    false,
  );
});

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

test("a version's recent stored probe of the same endpoint is reused, not repeated", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const stored = authProbeRecord(ARCMIRA_ENDPOINT, "oauth", daysAgo(29));
  mocks.storedProbes.mockResolvedValueOnce(
    new Map([
      [
        mcpServerVersionId("io.github.arcmira/arcmira", "0.10.7"),
        { authProbe: stored },
      ],
    ]),
  );
  const fetch = stubRegistryAndEndpoints([arcmiraEntry], () => {
    throw new Error("the endpoint must not be probed again");
  });

  const result = await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
  });

  assert.equal(endpointCalls(fetch).length, 0);
  assert.equal(result.authProbed, 0);
  assert.deepEqual(mocks.storedProbes.mock.calls[0]?.[0], [
    mcpServerVersionId("io.github.arcmira/arcmira", "0.10.7"),
  ]);
  const input = mocks.upsert.mock.calls[0]?.[0];
  assert.ok(input);
  assert.equal(input.manifest.auth.type, "oauth");
  // The reused record keeps its probe time, so it still expires.
  assert.deepEqual(input.provenanceJson.authProbe, stored);
});

test("a stored probe 30 days old, or without a probe time, is probed again", async () => {
  const versionId = mcpServerVersionId("io.github.arcmira/arcmira", "0.10.7");
  const { probedAt: _, ...untimed } = authProbeRecord(
    ARCMIRA_ENDPOINT,
    "open",
    new Date(),
  );
  for (const record of [
    authProbeRecord(ARCMIRA_ENDPOINT, "open", daysAgo(30)),
    untimed,
  ]) {
    vi.clearAllMocks();
    mocks.upsert.mockResolvedValue("item-id");
    mocks.storedProbes.mockResolvedValueOnce(
      new Map([[versionId, { authProbe: record }]]),
    );
    const fetch = stubRegistryAndEndpoints([arcmiraEntry], () =>
      oauthChallenge(),
    );

    const result = await ingestFromRegistry({
      source: "registry.test",
      baseUrl: "https://registry.test",
      verified: true,
    });

    assert.equal(initializeCalls(fetch).length, 1, JSON.stringify(record));
    assert.equal(result.authProbed, 1);
    const input = mocks.upsert.mock.calls[0]?.[0];
    assert.equal(input.manifest.auth.type, "oauth");
    assert.equal(input.provenanceJson.authProbe.result, "oauth");
    assert.ok(
      Date.now() - Date.parse(input.provenanceJson.authProbe.probedAt) < DAY_MS,
    );
  }
});

test("a stored probe is reused only when well-formed, same-endpoint and under 30 days old", () => {
  const now = new Date("2026-10-22T00:00:00.000Z");
  const at = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const record = authProbeRecord(ARCMIRA_ENDPOINT, "credential", at(1));
  assert.deepEqual(storedAuthProbe(record, ARCMIRA_ENDPOINT, now), {
    result: "credential",
    probedAt: at(1),
  });
  assert.ok(
    storedAuthProbe(
      authProbeRecord(
        ARCMIRA_ENDPOINT,
        "open",
        new Date(now.getTime() - DAY_MS * 30 + 1),
      ),
      ARCMIRA_ENDPOINT,
      now,
    ),
  );
  for (const stale of [
    authProbeRecord(ARCMIRA_ENDPOINT, "open", at(30)),
    authProbeRecord(ARCMIRA_ENDPOINT, "open", at(-1)),
    authProbeRecord("https://old.arcmira.com/mcp", "open", at(1)),
    { ...record, probedAt: "yesterday" },
    { ...record, probedAt: undefined },
    { ...record, result: "maybe" },
    null,
    "oauth",
  ]) {
    assert.equal(
      storedAuthProbe(stale, ARCMIRA_ENDPOINT, now),
      undefined,
      JSON.stringify(stale),
    );
  }
});

test("a stored probe of another endpoint is probed again", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  mocks.storedProbes.mockResolvedValueOnce(
    new Map([
      [
        mcpServerVersionId("io.github.arcmira/arcmira", "0.10.7"),
        {
          authProbe: authProbeRecord(
            "https://old.arcmira.com/mcp",
            "open",
            daysAgo(1),
          ),
        },
      ],
    ]),
  );
  const fetch = stubRegistryAndEndpoints([arcmiraEntry], () =>
    oauthChallenge(),
  );

  await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
  });

  assert.equal(initializeCalls(fetch).length, 1);
  assert.equal(mocks.upsert.mock.calls[0]?.[0].manifest.auth.type, "oauth");
});

test("a bare 401 with well-known protected-resource metadata is federated as OAuth", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const fetch = stubRegistryAndEndpoints([arcmiraEntry], (url) =>
    url === ARCMIRA_ENDPOINT
      ? new Response(null, { status: 401 })
      : url ===
          "https://mcp.arcmira.com/.well-known/oauth-protected-resource/mcp"
        ? new Response(
            JSON.stringify({
              resource: ARCMIRA_ENDPOINT,
              authorization_servers: ["https://auth.arcmira.com"],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response(null, { status: 404 }),
  );

  await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
  });

  // initialize, the path-specific metadata, the origin's server card.
  assert.equal(endpointCalls(fetch).length, 3);
  const input = mocks.upsert.mock.calls[0]?.[0];
  assert.equal(input.manifest.auth.type, "oauth");
  assert.equal(input.provenanceJson.authProbe.result, "oauth");
});

test("a failed probe keeps the run going, maps declared headers alone and stores nothing", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  stubRegistryAndEndpoints([arcmiraEntry, serverEntry(1)], (url) => {
    if (url === ARCMIRA_ENDPOINT) throw new TypeError("fetch failed");
    return new Response("{}", { status: 200 });
  });

  const result = await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
  });

  assert.equal(result.ingested, 2);
  assert.equal(result.authProbed, 1);
  assert.equal(result.authProbeFailed, 1);
  const arcmira = mocks.upsert.mock.calls.find(
    ([input]) => input.manifest.identifier === "io.github.arcmira/arcmira",
  )?.[0];
  // Its header is optional and the endpoint said nothing: listed as before.
  assert.equal(arcmira.manifest.auth.type, "none");
  assert.equal(arcmira.provenanceJson.authProbe, undefined);
});

test("a registry endpoint on a private address is never probed", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const fetch = stubRegistryAndEndpoints(
    [
      {
        server: {
          name: "io.github.acme/internal",
          version: "1.0.0",
          remotes: [{ type: "streamable-http", url: "https://127.0.0.1/mcp" }],
        },
      },
    ],
    () => oauthChallenge(),
  );

  const result = await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
  });

  assert.equal(endpointCalls(fetch).length, 0);
  assert.equal(result.authProbeFailed, 1);
  assert.equal(mocks.upsert.mock.calls[0]?.[0].manifest.auth.type, "none");
});

// The official registry's own entry for Notion, as read on 2026-10-24: no
// title, no repository, two remotes on mcp.notion.com.
const NOTION_REGISTRY_ENTRY = {
  server: {
    name: "com.notion/mcp",
    description: "Official Notion MCP server",
    repository: {},
    version: "1.0.1",
    remotes: [
      { type: "streamable-http", url: "https://mcp.notion.com/mcp" },
      { type: "sse", url: "https://mcp.notion.com/sse" },
    ],
  },
  _meta: {
    "io.modelcontextprotocol.registry/official": {
      status: "active",
      isLatest: true,
    },
  },
};

test("issue #367: a domain namespace is mapped to its publisher, matched against the endpoint", () => {
  const notion = mapRegistryServerToManifest(NOTION_REGISTRY_ENTRY, {
    verified: true,
  });
  assert.ok(notion);
  assert.deepEqual(notion.publisher, {
    domain: "notion.com",
    source: "registry-namespace",
    endpointMatch: true,
  });
  // The publisher is a new field beside the existing ones, which keep their
  // meaning: the namespace stays the provider name, the registry's
  // verification stays `verified`, and `official` stays the manual flag.
  assert.equal(notion.providerName, "com.notion");
  assert.equal(notion.verified, true);
  assert.equal(notion.official, false);

  const elsewhere = mapRegistryServerToManifest(
    {
      server: {
        name: "com.notion/community",
        version: "1.0.0",
        remotes: [{ type: "streamable-http", url: "https://notion-mcp.fly.dev/mcp" }],
      },
    },
    { verified: true },
  );
  assert.deepEqual(elsewhere?.publisher, {
    domain: "notion.com",
    source: "registry-namespace",
    endpointMatch: false,
  });
});

test("issue #367: a source that is not namespace-verified mints no publisher", () => {
  const manifest = mapRegistryServerToManifest(NOTION_REGISTRY_ENTRY, {
    verified: false,
  });
  assert.ok(manifest);
  assert.equal(manifest.publisher, undefined);
  assert.equal(manifest.verified, false);
});

test("issue #367: GitHub-namespace entries carry no publisher", () => {
  const manifest = mapRegistryServerToManifest(serverEntry(1), {
    verified: true,
  });
  assert.ok(manifest);
  assert.equal(manifest.publisher, undefined);
  // Stored as JSON, where an undefined field is no field at all.
  assert.equal("publisher" in JSON.parse(JSON.stringify(manifest)), false);
});

const OPEN_ENDPOINT = "https://mcp.open.test/mcp";
const openEntry = {
  server: {
    name: "io.github.acme/open",
    version: "2.0.0",
    description: "An open server.",
    remotes: [{ type: "streamable-http", url: OPEN_ENDPOINT }],
  },
};
const openVersionId = mcpServerVersionId("io.github.acme/open", "2.0.0");
const listedTools = [
  {
    name: "search",
    description: "Search the index.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    // The server's own claim; never the catalog risk.
    annotations: { readOnlyHint: true },
  },
  { name: "delete_all", inputSchema: { type: "object" } },
];

/**
 * A registry page with `entries`; every endpoint is an MCP server that answers
 * without credentials and lists `tools`. Returns the JSON-RPC methods each
 * endpoint received.
 */
function stubOpenMcpEndpoints(entries: unknown[], tools: unknown[]) {
  const methods: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.startsWith("https://registry.test/")) {
        return Response.json({
          servers: entries,
          metadata: { nextCursor: null },
        });
      }
      const request = new Request(input as RequestInfo, init);
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = (await request.json()) as { id?: number; method: string };
      methods.push({ url, method: message.method });
      if (message.id === undefined) return new Response(null, { status: 202 });
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result:
          message.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "open", version: "1" },
              }
            : { tools },
      });
    }),
  );
  return methods;
}

function ingestTestRegistry() {
  return ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
  });
}

test("an open endpoint's tools are listed into the manifest with an unknown risk", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const methods = stubOpenMcpEndpoints([openEntry], listedTools);

  const result = await ingestTestRegistry();

  assert.equal(result.toolsListed, 1);
  assert.equal(result.toolsListFailed, 0);
  // The auth probe's initialize, then the listing's own handshake.
  assert.deepEqual(
    methods.map((call) => call.method),
    ["initialize", "initialize", "notifications/initialized", "tools/list"],
  );
  const input = mocks.upsert.mock.calls[0]?.[0];
  assert.deepEqual(input.manifest.tools, [
    {
      name: "search",
      description: "Search the index.",
      inputSchema: listedTools[0]!.inputSchema,
      annotations: { readOnlyHint: true },
      risk: "unknown",
    },
    {
      name: "delete_all",
      inputSchema: { type: "object" },
      annotations: {},
      risk: "unknown",
    },
  ]);
  const listedAt = new Date(input.provenanceJson.toolsListing.listedAt);
  assert.deepEqual(
    input.provenanceJson.toolsListing,
    toolsListingRecord(OPEN_ENDPOINT, 2, listedAt),
  );
  assert.equal(
    JSON.stringify(input.provenanceJson.toolsListing).includes("open.test"),
    false,
  );
});

test("an endpoint that asks for a credential is not listed", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const fetch = stubRegistryAndEndpoints([arcmiraEntry], () =>
    oauthChallenge(),
  );

  const result = await ingestTestRegistry();

  // The probe's one initialize of the endpoint; no listing handshake after it
  // (its metadata and server-card lookups go to other URLs).
  assert.equal(initializeCalls(fetch).length, 1);
  assert.equal(result.toolsListed, 0);
  const input = mocks.upsert.mock.calls[0]?.[0];
  assert.deepEqual(input.manifest.tools, []);
  assert.equal(input.provenanceJson.toolsListing, undefined);
});

test("an endpoint URL with a query, user info or a template is not listed", async () => {
  for (const url of [
    "https://mcp.open.test/mcp?api_key=publisher-key",
    "https://user:pass@mcp.open.test/mcp",
    "https://{tenant}.open.test/mcp",
  ]) {
    vi.clearAllMocks();
    mocks.upsert.mockResolvedValue("item-id");
    const methods = stubOpenMcpEndpoints(
      [
        {
          server: {
            ...openEntry.server,
            remotes: [{ type: "streamable-http", url }],
          },
        },
      ],
      listedTools,
    );

    const result = await ingestTestRegistry();

    assert.equal(result.toolsListed, 0, url);
    assert.equal(
      methods.some((call) => call.method === "tools/list"),
      false,
      url,
    );
    assert.deepEqual(mocks.upsert.mock.calls[0]?.[0].manifest.tools, [], url);
  }
});

test("a version's recent stored listing is reused, not repeated", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const record = toolsListingRecord(OPEN_ENDPOINT, 1, daysAgo(29));
  mocks.storedProbes.mockResolvedValueOnce(
    new Map([
      [
        openVersionId,
        {
          authProbe: authProbeRecord(OPEN_ENDPOINT, "open", daysAgo(1)),
          toolsListing: record,
          tools: [{ ...listedTools[0], risk: "read" }],
        },
      ],
    ]),
  );
  const methods = stubOpenMcpEndpoints([openEntry], []);

  const result = await ingestTestRegistry();

  assert.deepEqual(methods, []);
  assert.equal(result.toolsListed, 0);
  const input = mocks.upsert.mock.calls[0]?.[0];
  assert.deepEqual(
    input.manifest.tools.map((tool: { name: string; risk: string }) => [
      tool.name,
      tool.risk,
    ]),
    // Stored tools are bounded again, risk included.
    [["search", "unknown"]],
  );
  assert.deepEqual(input.provenanceJson.toolsListing, record);
});

test("a failed listing keeps the stored tools and the run going", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const record = toolsListingRecord(OPEN_ENDPOINT, 1, daysAgo(40));
  mocks.storedProbes.mockResolvedValueOnce(
    new Map([
      [openVersionId, { toolsListing: record, tools: [listedTools[0]] }],
    ]),
  );
  stubRegistryAndEndpoints([openEntry, serverEntry(1)], (url) =>
    url === OPEN_ENDPOINT
      ? // The probe's initialize is answered; the listing's is not JSON-RPC.
        new Response("{}", { status: 200 })
      : new Response(null, { status: 401 }),
  );

  const result = await ingestTestRegistry();

  assert.equal(result.ingested, 2);
  assert.equal(result.toolsListed, 0);
  assert.equal(result.toolsListFailed, 1);
  const open = mocks.upsert.mock.calls.find(
    ([input]) => input.manifest.identifier === "io.github.acme/open",
  )?.[0];
  assert.deepEqual(
    open.manifest.tools.map((tool: { name: string }) => tool.name),
    ["search"],
  );
  // Still stale, so the next sync lists it again.
  assert.deepEqual(open.provenanceJson.toolsListing, record);
});

test("a stored listing is read back only for the same endpoint and with a valid time", () => {
  const now = new Date("2026-10-24T00:00:00.000Z");
  const at = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const tools = [listedTools[0]];
  assert.equal(
    storedToolsListing(
      { toolsListing: toolsListingRecord(OPEN_ENDPOINT, 1, at(1)), tools },
      OPEN_ENDPOINT,
      now,
    )?.fresh,
    true,
  );
  assert.equal(
    storedToolsListing(
      { toolsListing: toolsListingRecord(OPEN_ENDPOINT, 1, at(30)), tools },
      OPEN_ENDPOINT,
      now,
    )?.fresh,
    false,
  );
  for (const stored of [
    {
      toolsListing: toolsListingRecord("https://old.test/mcp", 1, at(1)),
      tools,
    },
    {
      toolsListing: {
        ...toolsListingRecord(OPEN_ENDPOINT, 1, at(1)),
        listedAt: "soon",
      },
    },
    { tools },
    undefined,
  ]) {
    assert.equal(
      storedToolsListing(stored, OPEN_ENDPOINT, now),
      undefined,
      JSON.stringify(stored),
    );
  }
});

test("a stdio-only entry gets no tools even when some are passed", () => {
  const manifest = mapRegistryServerToManifest(
    {
      server: {
        name: "io.github.acme/local",
        version: "1.0.0",
        packages: [{ registryType: "npm", identifier: "acme-local" }],
      },
    },
    {
      verified: true,
      tools: [{ name: "x", inputSchema: {}, annotations: {}, risk: "unknown" }],
    },
  );
  assert.deepEqual(manifest?.tools, []);
});

test("issue #367: the logo chain labels an io.github entry github-avatar and keeps a registry icon as registry", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  stubRegistryAndEndpoints(
    [
      serverEntry(1),
      {
        server: {
          name: "com.acme/mcp",
          version: "1.0.0",
          icons: [{ src: "https://cdn.acme.test/icon.png" }],
          remotes: [{ type: "streamable-http", url: "https://acme.test/mcp" }],
        },
      },
    ],
    () => new Response("{}", { status: 200 }),
  );

  const result = await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
  });

  assert.equal(result.ingested, 2);
  const manifests = mocks.upsert.mock.calls.map((call) => call[0].manifest);
  const acme = manifests.find(
    (m) => m.identifier === "io.github.acme/server-1",
  );
  assert.equal(acme?.iconUrl, "https://github.com/acme.png?size=128");
  assert.equal(acme?.iconSource, "github-avatar");
  const registry = manifests.find((m) => m.identifier === "com.acme/mcp");
  assert.equal(registry?.iconUrl, "https://cdn.acme.test/icon.png");
  assert.equal(registry?.iconSource, "registry");
  assert.equal(result.faviconFetched, 0);
});

test("issue #367: without public storage a domain entry stays a placeholder and no favicon service is called", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  // No public storage (the mocked store says so): the favicon step is skipped
  // and counted rather than fetched.
  mocks.storeConfigured = false;
  const fetch = stubRegistryAndEndpoints(
    [
      {
        server: {
          name: "com.notion/mcp",
          version: "1.0.1",
          repository: {},
          remotes: [
            { type: "streamable-http", url: "https://mcp.notion.com/mcp" },
          ],
        },
      },
    ],
    () => new Response("{}", { status: 200 }),
  );

  const result = await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
  });

  assert.equal(result.ingested, 1);
  assert.equal(result.faviconSkipped, 1);
  assert.equal(result.faviconFetched, 0);
  const input = mocks.upsert.mock.calls[0]?.[0];
  assert.equal(input.manifest.iconUrl, undefined);
  assert.equal(input.manifest.iconSource, "placeholder");
  assert.equal(input.provenanceJson.iconProbe, undefined);
  for (const call of fetch.mock.calls) {
    assert.doesNotMatch(requestUrl(call[0]), /google|duckduckgo/);
  }
});

test("issue #367: a cached favicon hit in provenance is reused, served from our URL and written back", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const hit = {
    domain: "notion.com",
    result: "hit",
    probedAt: new Date().toISOString(),
    url: "https://assets.test/market/mcp-icons/notion.com/abc.png",
    service: "google",
  };
  mocks.storedIconProvenance.mockResolvedValueOnce(
    new Map([
      [mcpServerVersionId("com.notion/mcp", "1.0.1"), { iconProbe: hit }],
    ]),
  );
  stubRegistryAndEndpoints(
    [
      {
        server: {
          name: "com.notion/mcp",
          version: "1.0.1",
          remotes: [
            { type: "streamable-http", url: "https://mcp.notion.com/mcp" },
          ],
        },
      },
    ],
    () => new Response("{}", { status: 200 }),
  );

  await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
  });

  const input = mocks.upsert.mock.calls[0]?.[0];
  assert.equal(input.manifest.iconUrl, hit.url);
  assert.equal(input.manifest.iconSource, "favicon");
  assert.deepEqual(input.provenanceJson.iconProbe, hit);
});

test("issue #367: with public storage a domain entry's favicon is fetched, stored and served from our URL", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  mocks.storeConfigured = true;
  const png = () =>
    new Response(new Uint8Array(Buffer.alloc(2048, 1)), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  const fetch = stubRegistryAndEndpoints(
    [
      {
        server: {
          name: "com.notion/mcp",
          version: "1.0.1",
          remotes: [
            { type: "streamable-http", url: "https://mcp.notion.com/mcp" },
          ],
        },
      },
    ],
    (url) =>
      url.startsWith("https://www.google.com/s2/favicons")
        ? png()
        : new Response("{}", { status: 200 }),
  );

  const result = await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
  });

  assert.equal(result.ingested, 1);
  assert.equal(result.faviconFetched, 1);
  assert.equal(result.faviconHits, 1);
  assert.equal(result.faviconSkipped, 0);
  const faviconCalls = fetch.mock.calls
    .map((call) => requestUrl(call[0]))
    .filter((url) => /google|duckduckgo/.test(url));
  assert.deepEqual(faviconCalls, [
    "https://www.google.com/s2/favicons?domain=notion.com&sz=128",
  ]);
  assert.equal(mocks.storeIcon.mock.calls.length, 1);
  assert.equal(mocks.storeIcon.mock.calls[0]?.[0].domain, "notion.com");
  const input = mocks.upsert.mock.calls[0]?.[0];
  assert.equal(
    input.manifest.iconUrl,
    "https://assets.test/market/mcp-icons/notion.com/stored.png",
  );
  assert.equal(input.manifest.iconSource, "favicon");
  assert.equal(input.provenanceJson.iconProbe.result, "hit");
  assert.equal(input.provenanceJson.iconProbe.domain, "notion.com");
  assert.equal(input.provenanceJson.iconProbe.service, "google");
});

test("issue #367: the registry icon the chain keeps is the first https one without credentials", () => {
  const manifest = mapRegistryServerToManifest(
    {
      server: {
        name: "com.acme/mcp",
        version: "1.0.0",
        icons: [
          { src: "https://user:pw@cdn.acme.test/secret.png" },
          { src: "https://cdn.acme.test/icon.png" },
        ],
        remotes: [{ type: "streamable-http", url: "https://acme.test/mcp" }],
      },
    },
    { verified: true },
  );
  assert.equal(manifest?.iconUrl, "https://cdn.acme.test/icon.png");
});

// ---------------------------------------------------------------------------
// Issue #367 W1: what the endpoint says about itself.
// ---------------------------------------------------------------------------

const OPEN_ORIGIN = new URL(OPEN_ENDPOINT).origin;
const OPEN_INITIALIZE = {
  protocolVersion: "2025-06-18",
  capabilities: { tools: { listChanged: false } },
  serverInfo: {
    name: "acme-open",
    title: "Acme Open",
    version: "2.0.0",
    websiteUrl: "https://acme.test/",
    icons: [{ src: "https://acme.test/icon.svg", mimeType: "image/svg+xml" }],
  },
  instructions: "Search first.",
};
const OPEN_TOOLS = [
  {
    name: "search",
    title: "Search",
    description: "Find documents.",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  { name: "delete_doc", inputSchema: { type: "object" } },
  { name: "run", annotations: { readOnlyHint: false, destructiveHint: false } },
];
const SERVER_CARD = {
  serverInfo: { name: "acme-open", version: "2.0.0" },
  protocolVersion: "2025-06-18",
};
// As the tool listing keeps them: the server's hints stay, the risk is never
// theirs (`delete_doc`, or a `readOnlyHint` on anything, is the server's own
// claim about itself).
const EXPECTED_TOOLS = [
  {
    name: "search",
    title: "Search",
    description: "Find documents.",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    annotations: { readOnlyHint: true },
    risk: "unknown",
  },
  {
    name: "delete_doc",
    inputSchema: { type: "object" },
    annotations: {},
    risk: "unknown",
  },
  {
    name: "run",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false },
    risk: "unknown",
  },
];

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * The registry page with `entries`, and `mcp` for every other request, given
 * the request itself (method, headers and body). `requests` keeps a readable
 * copy of each request the endpoints saw.
 */
function stubRegistryAndMcp(
  entries: unknown[],
  mcp: (request: Request) => Response | Promise<Response>,
) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(String(input), init);
    if (request.url.startsWith("https://registry.test/")) {
      return jsonResponse({ servers: entries, metadata: { nextCursor: null } });
    }
    requests.push(request.clone());
    return mcp(request);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, requests };
}

/**
 * An open MCP server at `OPEN_ENDPOINT` that both the probe and the tool
 * listing's client talk to; `tools` answers `tools/list`.
 */
function openMcp(options: { tools?: () => Response; card?: boolean } = {}) {
  return async (request: Request) => {
    if (request.url === `${OPEN_ORIGIN}/.well-known/mcp/server-card.json`) {
      return options.card
        ? jsonResponse(SERVER_CARD)
        : new Response(null, { status: 404 });
    }
    if (request.url !== OPEN_ENDPOINT) {
      return new Response(null, { status: 404 });
    }
    if (request.method === "DELETE") return new Response(null, { status: 200 });
    assert.equal(request.headers.get("authorization"), null);
    const message = (await request.json()) as { id?: number; method?: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === "initialize") {
      return jsonResponse(
        { jsonrpc: "2.0", id: message.id, result: OPEN_INITIALIZE },
        { "mcp-session-id": "open-1" },
      );
    }
    if (message.method === "tools/list") {
      return options.tools
        ? options.tools()
        : jsonResponse({
            jsonrpc: "2.0",
            id: message.id,
            result: { tools: OPEN_TOOLS },
          });
    }
    return jsonResponse({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    });
  };
}

async function postedMethods(requests: Request[]) {
  return Promise.all(
    requests
      .filter((request) => request.method === "POST")
      .map(
        async (request) =>
          ((await request.json()) as { method: string }).method,
      ),
  );
}

test("issue #367: an open endpoint's self-description is kept with the probe, validated by its listing", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const startedAt = Date.now();
  const { requests } = stubRegistryAndMcp([openEntry], openMcp({ card: true }));

  const result = await ingestTestRegistry();

  assert.equal(result.ingested, 1);
  assert.equal(result.authProbed, 1);
  assert.equal(result.toolsListed, 1);
  const input = mocks.upsert.mock.calls[0]?.[0];
  assert.ok(input);
  assert.equal(input.manifest.auth.type, "none");
  assert.deepEqual(input.manifest.tools, EXPECTED_TOOLS);
  const probedAt = new Date(input.provenanceJson.authProbe.probedAt);
  assert.ok(
    probedAt.getTime() >= startedAt && probedAt.getTime() <= Date.now(),
  );
  assert.equal(input.provenanceJson.authProbe.result, "open");
  assert.deepEqual(input.provenanceJson.selfDescription, {
    source: "remote-probe",
    recordedAt: probedAt.toISOString(),
    serverInfo: OPEN_INITIALIZE.serverInfo,
    instructions: OPEN_INITIALIZE.instructions,
    capabilities: OPEN_INITIALIZE.capabilities,
  });
  // Described and listed in the same run: validated at the listing's time.
  assert.equal(
    input.provenanceJson.validatedAt,
    input.provenanceJson.toolsListing.listedAt,
  );
  assert.deepEqual(input.provenanceJson.serverCard, SERVER_CARD);
  assert.equal(input.provenanceJson.authMetadata, undefined);
  // The probe's one initialize and the card lookup, then the listing's own
  // client handshake; nothing carried a credential.
  assert.deepEqual(await postedMethods(requests), [
    "initialize",
    "initialize",
    "notifications/initialized",
    "tools/list",
  ]);
  assert.ok(
    requests.some(
      (request) =>
        request.method === "GET" &&
        request.url === `${OPEN_ORIGIN}/.well-known/mcp/server-card.json`,
    ),
  );
});

test("issue #367: a failed listing leaves the entry described but unvalidated, with no tools", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  stubRegistryAndMcp(
    [openEntry],
    openMcp({ tools: () => new Response("oops", { status: 500 }) }),
  );

  const result = await ingestTestRegistry();

  assert.equal(result.toolsListFailed, 1);
  const input = mocks.upsert.mock.calls[0]?.[0];
  assert.deepEqual(input.manifest.tools, []);
  assert.equal(input.provenanceJson.validatedAt, undefined);
  assert.equal(input.provenanceJson.toolsListing, undefined);
  assert.equal(
    input.provenanceJson.selfDescription.serverInfo.name,
    "acme-open",
  );
  assert.equal(input.provenanceJson.authProbe.result, "open");
});

test("issue #367: a 401's protected-resource metadata keeps its documentation link, never fetched", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const fetch = stubRegistryAndEndpoints([arcmiraEntry], (url) =>
    url === ARCMIRA_ENDPOINT
      ? oauthChallenge()
      : url === "https://mcp.arcmira.com/.well-known/oauth-protected-resource"
        ? jsonResponse({
            resource: ARCMIRA_ENDPOINT,
            authorization_servers: ["https://auth.arcmira.com"],
            resource_name: "Arcmira MCP",
            resource_documentation: "https://docs.arcmira.com/mcp",
          })
        : new Response(null, { status: 404 }),
  );

  await ingestTestRegistry();

  const input = mocks.upsert.mock.calls[0]?.[0];
  assert.equal(input.manifest.auth.type, "oauth");
  assert.deepEqual(input.manifest.tools, []);
  assert.deepEqual(input.provenanceJson.authMetadata, {
    resourceName: "Arcmira MCP",
    resourceDocumentation: "https://docs.arcmira.com/mcp",
  });
  assert.equal(input.provenanceJson.selfDescription, undefined);
  assert.equal(input.provenanceJson.validatedAt, undefined);
  assert.equal(
    fetch.mock.calls.some(([input]) =>
      requestUrl(input).startsWith("https://docs.arcmira.com/"),
    ),
    false,
  );
});

test("issue #367: a reused stored probe brings its self-description, metadata and card along", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const probedAt = daysAgo(10);
  const stored = endpointProbeRecord(
    {
      result: "open",
      selfDescription: {
        serverInfo: OPEN_INITIALIZE.serverInfo,
        instructions: OPEN_INITIALIZE.instructions,
      },
      authMetadata: { resourceName: "Acme" },
      serverCard: SERVER_CARD,
    },
    probedAt,
  );
  mocks.storedProbes.mockResolvedValueOnce(
    new Map([
      [
        openVersionId,
        {
          authProbe: authProbeRecord(OPEN_ENDPOINT, "open", probedAt),
          selfDescription: stored.selfDescription,
          authMetadata: stored.authMetadata,
          serverCard: stored.serverCard,
          toolsListing: toolsListingRecord(OPEN_ENDPOINT, 3, probedAt),
          tools: EXPECTED_TOOLS,
        },
      ],
    ]),
  );
  const { requests } = stubRegistryAndMcp([openEntry], () => {
    throw new Error("the endpoint must not be contacted");
  });

  const result = await ingestTestRegistry();

  assert.equal(requests.length, 0);
  assert.equal(result.authProbed, 0);
  assert.equal(result.toolsListed, 0);
  const input = mocks.upsert.mock.calls[0]?.[0];
  assert.deepEqual(input.manifest.tools, EXPECTED_TOOLS);
  assert.deepEqual(
    input.provenanceJson.selfDescription,
    stored.selfDescription,
  );
  assert.equal(input.provenanceJson.validatedAt, probedAt.toISOString());
  assert.deepEqual(input.provenanceJson.authMetadata, { resourceName: "Acme" });
  assert.deepEqual(input.provenanceJson.serverCard, SERVER_CARD);
});

test("issue #367: stored pieces are reused only when well-formed and the probe's own", () => {
  assert.deepEqual(
    storedProbePieces({
      // Another source's self-description (the sandboxed stdio start) is not
      // the remote probe's.
      selfDescription: {
        source: "stdio-sandbox",
        recordedAt: "2026-10-24T00:00:00.000Z",
        serverInfo: { name: "x" },
      },
      authMetadata: { resourceDocumentation: "not a url" },
      serverCard: ["not", "an", "object"],
    }),
    {},
  );
  assert.deepEqual(storedProbePieces(undefined), {});
  const kept = {
    selfDescription: {
      source: "remote-probe",
      recordedAt: "2026-10-24T00:00:00.000Z",
      instructions: "hi",
    },
    authMetadata: { resourceName: "Acme" },
    serverCard: SERVER_CARD,
  };
  assert.deepEqual(storedProbePieces(kept), kept);
});

test("issue #367: a fresh probe without an initialize answer stores no self-description", () => {
  const at = new Date("2026-10-24T00:00:00.000Z");
  assert.deepEqual(endpointProbeRecord({ result: "credential" }, at), {
    result: "credential",
    probedAt: at,
  });
  assert.deepEqual(
    endpointProbeRecord(
      { result: "open", selfDescription: { instructions: "hi" } },
      at,
    ),
    {
      result: "open",
      probedAt: at,
      selfDescription: {
        source: "remote-probe",
        recordedAt: at.toISOString(),
        instructions: "hi",
      },
    },
  );
});

test("issue #367: a failed fresh probe keeps the version's stored one, however old", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const probedAt = daysAgo(45);
  const stored = endpointProbeRecord(
    {
      result: "open",
      selfDescription: { serverInfo: OPEN_INITIALIZE.serverInfo },
    },
    probedAt,
  );
  mocks.storedProbes.mockResolvedValueOnce(
    new Map([
      [
        openVersionId,
        {
          authProbe: authProbeRecord(OPEN_ENDPOINT, "open", probedAt),
          selfDescription: stored.selfDescription,
          toolsListing: toolsListingRecord(OPEN_ENDPOINT, 3, probedAt),
          tools: EXPECTED_TOOLS,
        },
      ],
    ]),
  );
  stubRegistryAndMcp([openEntry], () => {
    throw new TypeError("fetch failed");
  });

  const result = await ingestTestRegistry();

  // The stale probe and listing were retried (and failed); the entry kept
  // what it had, and keeps its old times so both are retried next sync.
  assert.equal(result.authProbeFailed, 1);
  assert.equal(result.toolsListFailed, 1);
  const input = mocks.upsert.mock.calls[0]?.[0];
  assert.deepEqual(input.manifest.tools, EXPECTED_TOOLS);
  assert.deepEqual(
    input.provenanceJson.selfDescription,
    stored.selfDescription,
  );
  assert.equal(input.provenanceJson.validatedAt, probedAt.toISOString());
  assert.equal(input.provenanceJson.authProbe.probedAt, probedAt.toISOString());
  assert.equal(
    input.provenanceJson.toolsListing.listedAt,
    probedAt.toISOString(),
  );
});

test("issue #367: the icon dry-run gets each entry's evidence, rides on the provenance and leaves the displayed icon alone", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const versionId = mcpServerVersionId("com.notion/mcp", "1.0.1");
  const iconCandidates = { version: 1, checkedAt: "2026-10-24T00:00:00.000Z", items: [] };
  const iconDecision = { version: 1, outcome: "placeholder", reasons: ["no-candidates"] };
  mocks.iconDryRun.mockResolvedValueOnce({
    provenance: new Map([[versionId, { iconCandidates, iconDecision }]]),
    counts: {
      entries: 1,
      collected: 1,
      reused: 0,
      skipped: 0,
      failed: 0,
      sitesScraped: 1,
      candidatesAccepted: 2,
      picks: 0,
      placeholders: 1,
      differs: 1,
    },
  });
  stubRegistryAndEndpoints(
    [
      {
        server: {
          name: "com.notion/mcp",
          version: "1.0.1",
          websiteUrl: "https://www.notion.com",
          repository: { url: "https://github.com/makenotion/notion-mcp" },
          icons: [{ src: "https://cdn.notion.test/icon.png" }],
          remotes: [
            { type: "streamable-http", url: "https://mcp.notion.com/mcp" },
          ],
        },
      },
    ],
    () => new Response("{}", { status: 200 }),
  );

  const result = await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
  });

  // The step was handed the entry's declarations and today's icon.
  const [entries] = mocks.iconDryRun.mock.calls[0]!;
  assert.deepEqual(entries, [
    {
      key: versionId,
      identifier: "com.notion/mcp",
      endpointUrl: "https://mcp.notion.com/mcp",
      repositoryUrl: "https://github.com/makenotion/notion-mcp",
      registryIconUrl: "https://cdn.notion.test/icon.png",
      registryWebsiteUrl: "https://www.notion.com",
      verified: true,
      selfDescription: undefined,
      authMetadata: undefined,
      faviconUrl: undefined,
      current: {
        iconSource: "registry",
        iconUrl: "https://cdn.notion.test/icon.png",
      },
    },
  ]);
  // Its records are stored; the displayed icon is still the chain's.
  const input = mocks.upsert.mock.calls[0]?.[0];
  assert.deepEqual(input.provenanceJson.iconCandidates, iconCandidates);
  assert.deepEqual(input.provenanceJson.iconDecision, iconDecision);
  assert.equal(input.manifest.iconUrl, "https://cdn.notion.test/icon.png");
  assert.equal(input.manifest.iconSource, "registry");
  // Counts reach the run summary.
  assert.equal(result.iconDryRun.sitesScraped, 1);
  assert.equal(result.iconDryRun.differs, 1);
});

test("issue #367: the displayed icon is the same whatever the dry-run decides", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const versionId = mcpServerVersionId("io.github.acme/server-1", "1.0.0");
  const run = async (provenance: Map<string, { iconCandidates?: unknown; iconDecision?: unknown }>) => {
    mocks.upsert.mockClear();
    mocks.iconDryRun.mockResolvedValueOnce({
      provenance,
      counts: {
        entries: 1, collected: 1, reused: 0, skipped: 0, failed: 0, sitesScraped: 0,
        candidatesAccepted: 0, picks: 0, placeholders: 0, differs: 0,
      },
    });
    stubRegistryAndEndpoints([serverEntry(1)], () => new Response("{}", { status: 200 }));
    await ingestFromRegistry({ source: "registry.test", baseUrl: "https://registry.test", verified: true });
    const input = mocks.upsert.mock.calls[0]?.[0];
    return [input.manifest.iconUrl, input.manifest.iconSource];
  };
  const withPick = await run(
    new Map([[versionId, { iconDecision: { outcome: "pick", pick: { storedUrl: "https://assets.test/x.png" } } }]]),
  );
  const withNothing = await run(new Map());
  assert.deepEqual(withPick, withNothing);
  assert.deepEqual(withNothing, ["https://github.com/acme.png?size=128", "github-avatar"]);
});
