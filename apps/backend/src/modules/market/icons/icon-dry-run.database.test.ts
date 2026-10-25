import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  marketMcpManifestSchema,
  type MarketMcpManifest,
} from "@sourceweft/market-contracts";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

/**
 * The icon dry-run's shared state in PostgreSQL (Issue #367): the lease and
 * cache every worker shares, the hash → domains record, the claimed-domain
 * lookup and the provenance round trip.
 */

const tag = `ic${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const T0 = new Date("2026-10-24T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

function manifest(identifier: string): MarketMcpManifest {
  return marketMcpManifestSchema.parse({
    schemaVersion: 1,
    identifier,
    version: "1.0.0",
    name: "Acme",
    summary: "An MCP server.",
    transport: "streamable_http",
    endpointUrl: `https://mcp.${tag}.com/mcp`,
    categories: [],
  });
}

describe("icon dry-run state", () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let data: typeof import("@sourceweft/db");
  let state: typeof import("./icon-state-repository");
  let withScope: typeof import("./icon-state");
  let repository: typeof import("./icon-dry-run-repository");
  let ingest: typeof import("../ingest/repository");
  let plan: typeof import("../ingest/plan");
  const originalUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase("mcp_icon_dry_run");
    process.env.DATABASE_URL = isolated.url;
    data = await import("@sourceweft/db");
    state = await import("./icon-state-repository");
    withScope = await import("./icon-state");
    repository = await import("./icon-dry-run-repository");
    ingest = await import("../ingest/repository");
    plan = await import("../ingest/plan");
  }, 120_000);

  afterAll(async () => {
    if (data) await data.closeDatabase();
    if (isolated) await isolated.close();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  test("of many workers racing for one new scope exactly one gets the lease", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        state.iconStateStore.acquireLease(`site:${tag}-race.com`, `w${i}`, T0, 120_000),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("lease, settle, shared cache, expiry and backoff against the real table", async () => {
    const scope = `site:${tag}-cycle.com`;
    let fetches = 0;
    const run = (owner: string, now: Date, status: "ok" | "error" = "ok") =>
      withScope.withIconScope<{ n: number }>(state.iconStateStore, scope, { owner, now }, async () => {
        fetches += 1;
        return { status, result: { n: fetches } };
      });
    expect(await run("w1", T0)).toMatchObject({ kind: "fetched", result: { n: 1 } });
    // Another worker, later the same month: served from the shared row.
    expect(await run("w2", at(7 * 24 * 3600 * 1000))).toMatchObject({
      kind: "cached",
      status: "ok",
      result: { n: 1 },
    });
    expect(fetches).toBe(1);
    // After 30 days it is fetched again; an error then backs off.
    const refresh = at(31 * 24 * 3600 * 1000);
    expect(await run("w2", refresh, "error")).toMatchObject({ kind: "fetched", status: "error" });
    const row = await state.iconStateStore.read(scope);
    expect(row).toMatchObject({ status: "error", errorCount: 1, leaseOwner: null });
    expect(row!.nextAttemptAt.getTime() - refresh.getTime()).toBe(6 * 3600 * 1000);
    expect(await run("w3", at(refresh.getTime() - T0.getTime() + 3600 * 1000))).toMatchObject({
      kind: "cached",
      status: "error",
    });
  });

  test("a live lease blocks other workers and an expired one is taken over", async () => {
    const scope = `url:${tag}-lease`;
    expect(await state.iconStateStore.acquireLease(scope, "dead", T0, 60_000)).toBe(true);
    expect(await state.iconStateStore.acquireLease(scope, "live", at(30_000), 60_000)).toBe(false);
    expect(await state.iconStateStore.acquireLease(scope, "live", at(61_000), 60_000)).toBe(true);
    // The dead worker cannot settle over the new holder.
    await state.iconStateStore.settle(scope, "dead", {
      status: "ok",
      resultJson: { by: "dead" },
      errorCount: 0,
      fetchedAt: at(62_000),
      nextAttemptAt: at(10 ** 9),
    });
    expect((await state.iconStateStore.read(scope))?.resultJson).toBeNull();
  });

  test("hash domains count distinct registrable domains", async () => {
    const sha256 = "c".repeat(64);
    const record = state.iconStateStore.recordHashDomain;
    await record({ sha256, domain: "notion.so" });
    await record({ sha256, domain: "notion.com" });
    await record({ sha256, domain: "notion.com" });
    expect(await state.iconStateStore.countHashDomains(sha256)).toBe(2);
    await record({ sha256, domain: "acme.io" });
    expect(await state.iconStateStore.countHashDomains(sha256)).toBe(3);
  });

  test("stored dry-run records come back with the icon provenance, and the review query finds the newest", async () => {
    const identifier = `com.${tag}/mcp`;
    const iconCandidates = { version: 1, checkedAt: T0.toISOString(), inputKey: "k", complete: true, items: [] };
    const iconDecision = {
      version: 1,
      decidedAt: T0.toISOString(),
      site: { tier: "none", reasons: [] },
      outcome: "placeholder",
      reasons: ["no-candidates"],
      disagreement: false,
      current: { iconSource: "favicon", iconUrl: "https://assets.test/x.png" },
    };
    await ingest.upsertMarketMcp({
      manifest: manifest(identifier),
      status: "published",
      visibility: "public",
      origin: "upstream",
      source: "registry.test",
      provenanceJson: { source: "registry.test", iconCandidates, iconDecision },
    });
    const versionId = plan.mcpServerVersionId(identifier, "1.0.0");
    const stored = await ingest.findStoredIconProvenance([versionId]);
    expect(stored.get(versionId)).toMatchObject({ iconCandidates, iconDecision });
    const rows = await repository.findReviewRows();
    expect(rows.find((r) => r.identifier === identifier)).toMatchObject({
      version: "1.0.0",
      decision: { outcome: "placeholder" },
    });
  });

  test("only verified domain claims count as claimed domains", async () => {
    const identifier = `com.${tag}-claimed/mcp`;
    await ingest.upsertMarketMcp({
      manifest: manifest(identifier),
      status: "published",
      visibility: "public",
      origin: "upstream",
      source: "registry.test",
      provenanceJson: { source: "registry.test" },
    });
    const serverId = plan.mcpServerId(identifier);
    const claim = (method: "github" | "dns_txt" | "well_known", status: "pending" | "verified", target: string, userId: string) =>
      data.db.insert(data.marketMcpClaims).values({
        id: randomUUID(),
        serverId,
        userId,
        method,
        status,
        target,
      });
    await claim("dns_txt", "verified", `${tag}-claimed.com`, "u1");
    await claim("github", "verified", "acme", "u2");
    await claim("well_known", "pending", "pending.example", "u3");
    const claimed = await repository.findClaimedDomains([identifier, "io.github.nobody/none"]);
    expect(claimed.get(identifier)).toEqual([`${tag}-claimed.com`]);
    expect(claimed.has("io.github.nobody/none")).toBe(false);
  });
});
