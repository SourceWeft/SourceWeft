import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  storedProbes: vi.fn(
    async (_versionIds: string[]) => new Map<string, Record<string, unknown>>(),
  ),
}));

vi.mock("./ingest/repository", () => ({
  upsertMarketMcp: mocks.upsert,
  findStoredEndpointProbes: mocks.storedProbes,
}));
vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import {
  authProbeRecord,
  endpointProbeRecord,
  ingestFromRegistry,
  mapRegistryServerToManifest,
  registryRemoteAuth,
  registryRepositoryProvenance,
  storedAuthProbe,
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
  });

  // The two page-1 servers were upserted and must be reported, not lost.
  assert.equal(result.ingested, 2);
  assert.equal(result.partial, true);
  assert.ok(result.error?.includes("fetch failed"));
  assert.equal(mocks.upsert.mock.calls.length, 2);
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
  assert.deepEqual(
    storedAuthProbe(storedRow({ authProbe: record }), ARCMIRA_ENDPOINT, now),
    {
      result: "credential",
      probedAt: at(1),
      tools: [],
    },
  );
  assert.ok(
    storedAuthProbe(
      storedRow({
        authProbe: authProbeRecord(
          ARCMIRA_ENDPOINT,
          "open",
          new Date(now.getTime() - DAY_MS * 30 + 1),
        ),
      }),
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
      storedAuthProbe(storedRow({ authProbe: stale }), ARCMIRA_ENDPOINT, now),
      undefined,
      JSON.stringify(stale),
    );
  }
  assert.equal(storedAuthProbe(undefined, ARCMIRA_ENDPOINT, now), undefined);
});

/** A `findStoredEndpointProbes` row with the given pieces. */
function storedRow(pieces: Record<string, unknown>) {
  return {
    authProbe: undefined,
    selfDescription: undefined,
    validatedAt: undefined,
    authMetadata: undefined,
    serverCard: undefined,
    tools: undefined,
    ...pieces,
  };
}

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

// ---------------------------------------------------------------------------
// Issue #367 W1: what the endpoint says about itself.
// ---------------------------------------------------------------------------

const OPEN_ENDPOINT = "https://open.acme.test/mcp";
const openEntry = {
  server: {
    name: "io.github.acme/open",
    version: "2.0.0",
    description: "Answers anyone.",
    remotes: [{ type: "streamable-http", url: OPEN_ENDPOINT }],
  },
  _meta: {
    "io.modelcontextprotocol.registry/official": { isLatest: true },
  },
};
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

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * The registry page with `entries`, and `mcp` for every other request, given
 * the request itself (the probe's method, headers and body). `requests` keeps
 * a readable copy of each request the endpoints saw.
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

/** An open MCP server at `OPEN_ENDPOINT`; `tools` answers `tools/list`. */
function openMcp(
  options: {
    tools?: () => Response;
    card?: boolean;
  } = {},
) {
  return async (request: Request) => {
    if (
      request.url === `https://open.acme.test/.well-known/mcp/server-card.json`
    ) {
      return options.card
        ? jsonResponse(SERVER_CARD)
        : new Response(null, { status: 404 });
    }
    if (request.url !== OPEN_ENDPOINT)
      return new Response(null, { status: 404 });
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

const EXPECTED_TOOLS = [
  {
    name: "search",
    title: "Search",
    description: "Find documents.",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    annotations: { readOnlyHint: true },
    risk: "read",
  },
  {
    name: "delete_doc",
    inputSchema: { type: "object" },
    annotations: {},
    risk: "destructive",
  },
  {
    name: "run",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false },
    risk: "write",
  },
];

test("issue #367: an open endpoint's tools and self-description are federated with the probe", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const startedAt = Date.now();
  const { requests } = stubRegistryAndMcp([openEntry], openMcp({ card: true }));

  const result = await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
  });

  assert.equal(result.ingested, 1);
  assert.equal(result.authProbed, 1);
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
  assert.equal(input.provenanceJson.validatedAt, probedAt.toISOString());
  assert.deepEqual(input.provenanceJson.serverCard, SERVER_CARD);
  assert.equal(input.provenanceJson.authMetadata, undefined);
  // The handshake a client makes, the probe's session carried through.
  const methods = await Promise.all(
    requests.map(async (request) =>
      request.method === "POST"
        ? ((await request.json()) as { method: string }).method
        : `${request.method} ${new URL(request.url).pathname}`,
    ),
  );
  assert.deepEqual(methods, [
    "initialize",
    "notifications/initialized",
    "tools/list",
    "DELETE /mcp",
    "GET /.well-known/mcp/server-card.json",
  ]);
});

test("issue #367: a failed tools/list leaves the entry's tools empty and unvalidated", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  stubRegistryAndMcp(
    [openEntry],
    openMcp({ tools: () => new Response("oops", { status: 500 }) }),
  );

  await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
  });

  const input = mocks.upsert.mock.calls[0]?.[0];
  assert.deepEqual(input.manifest.tools, []);
  assert.equal(input.provenanceJson.validatedAt, undefined);
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

  await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
  });

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

test("issue #367: a reused stored probe brings its tools, self-description, metadata and card along", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  const probedAt = daysAgo(10);
  const stored = endpointProbeRecord(
    {
      result: "open",
      selfDescription: {
        serverInfo: OPEN_INITIALIZE.serverInfo,
        instructions: OPEN_INITIALIZE.instructions,
      },
      tools: OPEN_TOOLS,
      authMetadata: { resourceName: "Acme" },
      serverCard: SERVER_CARD,
    },
    probedAt,
  );
  mocks.storedProbes.mockResolvedValueOnce(
    new Map([
      [
        mcpServerVersionId("io.github.acme/open", "2.0.0"),
        storedRow({
          authProbe: authProbeRecord(OPEN_ENDPOINT, "open", probedAt),
          selfDescription: stored.selfDescription,
          validatedAt: stored.validatedAt,
          authMetadata: stored.authMetadata,
          serverCard: stored.serverCard,
          tools: stored.tools,
        }),
      ],
    ]),
  );
  const { requests } = stubRegistryAndMcp([openEntry], () => {
    throw new Error("the endpoint must not be probed again");
  });

  const result = await ingestFromRegistry({
    source: "registry.test",
    baseUrl: "https://registry.test",
    verified: true,
  });

  assert.equal(requests.length, 0);
  assert.equal(result.authProbed, 0);
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
  const now = new Date("2026-10-24T00:00:00.000Z");
  const authProbe = authProbeRecord(OPEN_ENDPOINT, "open", daysAgo(1));
  const reused = storedAuthProbe(
    storedRow({
      authProbe,
      // Another workstream's self-description is not the remote probe's.
      selfDescription: {
        source: "sandbox-stdio",
        recordedAt: now.toISOString(),
        serverInfo: { name: "x" },
      },
      validatedAt: 12345,
      authMetadata: { resourceDocumentation: "not a url" },
      serverCard: ["not", "an", "object"],
      tools: [{ noName: true }],
    }),
    OPEN_ENDPOINT,
    now,
  );
  assert.deepEqual(reused, {
    result: "open",
    probedAt: new Date(authProbe.probedAt),
    tools: [],
  });
});

test("issue #367: a fresh probe without an initialize answer stores no self-description and no validation", () => {
  const at = new Date("2026-10-24T00:00:00.000Z");
  assert.deepEqual(endpointProbeRecord({ result: "credential" }, at), {
    result: "credential",
    probedAt: at,
    tools: [],
  });
  // Described but not listed: no validation time.
  const described = endpointProbeRecord(
    { result: "open", selfDescription: { instructions: "hi" } },
    at,
  );
  assert.equal(described.validatedAt, undefined);
  assert.deepEqual(described.selfDescription, {
    source: "remote-probe",
    recordedAt: at.toISOString(),
    instructions: "hi",
  });
  // Listed none: validated, with an empty list.
  const empty = endpointProbeRecord(
    { result: "open", selfDescription: {}, tools: [] },
    at,
  );
  assert.equal(empty.validatedAt, at.toISOString());
  assert.deepEqual(empty.tools, []);
});
