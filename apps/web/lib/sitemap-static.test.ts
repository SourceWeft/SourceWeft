import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ counts: vi.fn(), collections: vi.fn() }));
vi.mock("./blog-db", () => ({
  listPublishedBlogPosts: async () => [],
  listPublishedBlogSitemapEntries: async () => [],
}));
vi.mock("./market-mcp", () => ({
  requirePublicMcpCounts: mocks.counts,
  requirePublicMcpCategories: async () => ({
    items: [{ slug: "desktop-tools", name: "Desktop" }],
  }),
}));
vi.mock("./market-skills", () => ({
  requirePublicSkillCategories: async () => ({ items: [] }),
  requirePublicSkillCollections: mocks.collections,
}));
import { buildStaticSitemap } from "./sitemap-static";
import { SITE_URL } from "../app/seo";
beforeEach(() => {
  mocks.counts.mockReset();
  mocks.collections.mockResolvedValue({ items: [] });
});
it("uses complete category counts including desktop-only details, matching the canonical category page", async () => {
  mocks.counts.mockResolvedValue({
    counts: { "desktop-tools": 100 },
    total: 100,
  });
  const entries = await buildStaticSitemap();
  expect(mocks.counts).toHaveBeenCalledWith({ includeDesktopOnly: true });
  expect(
    entries.some((e) => e.url === SITE_URL + "/mcp/category/desktop-tools"),
  ).toBe(true);
});
it("propagates an editorial catalog outage instead of dropping its URLs", async () => {
  mocks.counts.mockResolvedValue({ counts: {}, total: 0 });
  mocks.collections.mockRejectedValueOnce(new Error("offline"));
  await expect(buildStaticSitemap()).rejects.toThrow("offline");
});
