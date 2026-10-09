import { beforeEach, expect, test, vi } from "vitest";
import { createRouteTestApp } from "../../test/hono";
const mocks = vi.hoisted(() => ({ index: vi.fn(), shard: vi.fn() }));
vi.mock("../../modules/catalog-sitemap/repository", () => ({
  readCatalogSitemapIndex: mocks.index,
  readCatalogSitemapShard: mocks.shard,
}));
import { registerSitemapRoutes } from "./sitemaps";
beforeEach(() => vi.resetAllMocks());
test("serves public lightweight shards without a session", async () => {
  mocks.index.mockResolvedValue({
    shards: [{ kind: "skills", prefix: "a", count: 1 }],
  });
  mocks.shard.mockResolvedValue({
    items: [{ key: "retained-slug", updatedAt: null, overviewLocales: [] }],
  });
  const app = createRouteTestApp(registerSitemapRoutes);
  const index = await app.request("/v1/sitemaps");
  expect(index.status).toBe(200);
  expect(index.headers.get("cache-control")).toContain("public");
  const shard = await app.request("/v1/sitemaps/skills/a");
  expect(shard.status).toBe(200);
  expect(mocks.shard).toHaveBeenCalledWith("skills", "a");
  expect((await shard.json()).items[0].key).toBe("retained-slug");
});
test("rejects invalid source kinds and prefixes before querying", async () => {
  const app = createRouteTestApp(registerSitemapRoutes);
  for (const path of [
    "private/a",
    "skills/AA",
    "skills/not-hex",
    "mcp/" + "a".repeat(33),
  ])
    expect((await app.request("/v1/sitemaps/" + path)).status).toBe(404);
  expect(mocks.shard).not.toHaveBeenCalled();
});
test("a failed read is not cached as an empty sitemap", async () => {
  mocks.index.mockRejectedValue(new Error("database unavailable"));
  const response = await createRouteTestApp(registerSitemapRoutes).request(
    "/v1/sitemaps",
  );
  expect(response.status).toBe(500);
  expect(response.headers.get("cache-control") ?? "").not.toContain("public");
});
