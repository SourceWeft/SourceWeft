import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  storedProbes: vi.fn(
    async (_versionIds: string[]) => new Map<string, unknown>(),
  ),
}));

vi.mock("./ingest/repository", () => ({
  upsertMarketMcp: mocks.upsert,
  findStoredAuthProbes: mocks.storedProbes,
}));
vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import {
  authProbeRecord,
  ingestFromRegistry,
  mapRegistryServerToManifest,
  registryRemoteAuth,
  registryRepositoryProvenance,
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
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ servers: entries, metadata: { nextCursor: null } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );

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
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ servers: entries, metadata: { nextCursor: null } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );

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
  });
});

test("registry auth: an OAuth challenge without a credential header is OAuth only", () => {
  assert.deepEqual(registryRemoteAuth(remote([]), "oauth"), {
    type: "oauth",
    required: true,
    headerName: undefined,
    allowedHeaderNames: [],
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
    },
  );
  assert.equal(registryRemoteAuth(undefined, undefined).type, "none");
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
  });
  assert.deepEqual(
    input.provenanceJson.authProbe,
    authProbeRecord(ARCMIRA_ENDPOINT, "oauth"),
  );
  assert.equal(input.provenanceJson.authProbe.endpointSha256.length, 64);
  assert.equal(
    JSON.stringify(input.provenanceJson.authProbe).includes("arcmira.com"),
    false,
  );
});

test("a version's stored probe of the same endpoint is reused, not repeated", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  mocks.storedProbes.mockResolvedValueOnce(
    new Map([
      [
        mcpServerVersionId("io.github.arcmira/arcmira", "0.10.7"),
        authProbeRecord(ARCMIRA_ENDPOINT, "oauth"),
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
  assert.deepEqual(
    input.provenanceJson.authProbe,
    authProbeRecord(ARCMIRA_ENDPOINT, "oauth"),
  );
});

test("a stored probe of another endpoint is probed again", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  mocks.storedProbes.mockResolvedValueOnce(
    new Map([
      [
        mcpServerVersionId("io.github.arcmira/arcmira", "0.10.7"),
        authProbeRecord("https://old.arcmira.com/mcp", "open"),
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

  assert.equal(endpointCalls(fetch).length, 1);
  assert.equal(mocks.upsert.mock.calls[0]?.[0].manifest.auth.type, "oauth");
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
