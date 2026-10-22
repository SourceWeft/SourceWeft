import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "dotenv";

/**
 * Federate ONE live entry of the official MCP registry into the isolated e2e
 * deployment through the real federation path (`ingestFromRegistry`). The
 * entry is read from the registry as it is today and handed to the ingest by
 * a local one-entry registry, so the mapping, the endpoint auth probe and the
 * catalog upsert run exactly as the scheduled sync runs them, without walking
 * the whole registry.
 *
 * Run from `apps/backend`:
 *   pnpm exec tsx scripts/federate-registry-entry-e2e.ts io.github.arcmira/arcmira
 *
 * Refuses any database but an isolated `sourceweft_skillv6_*` one, like
 * `reset-skills-e2e.ts`.
 */
const REGISTRY_SOURCE = "registry.modelcontextprotocol.io";
const identifier = process.argv[2]?.trim();
// The registry to read the entry from: the official one unless a test points
// at its own (the mock MCP server serves `/v0/servers`).
const registryBase = process.argv[3]?.trim() || `https://${REGISTRY_SOURCE}`;
if (!identifier) {
  throw new Error(
    "Usage: federate-registry-entry-e2e.ts <registry identifier> [registry base URL]",
  );
}

const envPath = resolve(".env.skills-test");
const env = parse(await readFile(envPath));
if (!new URL(env.DATABASE_URL!).pathname.startsWith("/sourceweft_skillv6_"))
  throw new Error("Refusing non-isolated database");
// `shared/config` loads `dotenv/config`, which never overrides a variable
// already set, so the test values go in first.
process.env.DOTENV_CONFIG_PATH = envPath;
Object.assign(process.env, env);

const upstream = new URL("/v0/servers", registryBase);
upstream.searchParams.set("search", identifier);
upstream.searchParams.set("version", "latest");
const response = await fetch(upstream, {
  headers: { accept: "application/json" },
});
if (!response.ok) {
  throw new Error(`Registry responded ${response.status} for ${identifier}`);
}
const page = (await response.json()) as {
  servers?: Array<{ server?: { name?: string } }>;
};
const entries = (page.servers ?? []).filter(
  (entry) => entry.server?.name === identifier,
);
if (entries.length !== 1) {
  throw new Error(
    `Expected exactly one latest registry entry for ${identifier}, got ${entries.length}`,
  );
}

const registry = createServer((_request, reply) => {
  reply.writeHead(200, { "content-type": "application/json" });
  reply.end(JSON.stringify({ servers: entries, metadata: { count: 1 } }));
});
await new Promise<void>((done) => registry.listen(0, "127.0.0.1", done));
const { port } = registry.address() as AddressInfo;

const { ingestFromRegistry } = await import("../src/modules/market/federation");
const { closeDatabase } = await import("@sourceweft/db");

let exitCode = 0;
try {
  const result = await ingestFromRegistry({
    source: REGISTRY_SOURCE,
    baseUrl: `http://127.0.0.1:${port}`,
    verified: true,
  });
  console.log(JSON.stringify({ identifier, result }));
  if (result.ingested !== 1) exitCode = 1;
} catch (error) {
  exitCode = 1;
  console.error(
    "Registry entry federation failed:",
    error instanceof Error ? error.message : String(error),
  );
} finally {
  registry.close();
  await closeDatabase();
}
process.exit(exitCode);
