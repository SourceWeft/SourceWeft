import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upsert: vi.fn() }));

vi.mock("./ingest/repository", () => ({ upsertMarketMcp: mocks.upsert }));
vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import {
  ingestFromRegistry,
  mapRegistryServerToManifest,
  registryRepositoryProvenance,
} from "./federation";

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
