import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upsert: vi.fn() }));

vi.mock("./ingest/repository", () => ({ upsertMarketMcp: mocks.upsert }));
vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import { ingestFromRegistry, mapRegistryServerToManifest } from "./federation";

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

test("a clean walk to the end reports the full count and is not partial", async () => {
  mocks.upsert.mockResolvedValue("item-id");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      const cursor = url.searchParams.get("cursor");
      const body = cursor
        ? { servers: [serverEntry(3)], metadata: { nextCursor: null } }
        : { servers: [serverEntry(1), serverEntry(2)], metadata: { nextCursor: "page-2" } };
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
