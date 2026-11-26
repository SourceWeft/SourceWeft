import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  counts: vi.fn(),
  collections: vi.fn(),
  blogEntries: vi.fn(),
  capabilities: vi.fn(),
}));
vi.mock("./billing-edition/capabilities-server", () => ({
  resolveDeploymentCapabilities: mocks.capabilities,
}));
vi.mock("./blog-db", () => ({
  listPublishedBlogPosts: async () => [],
  listPublishedBlogSitemapEntries: mocks.blogEntries,
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
  mocks.blogEntries.mockResolvedValue([]);
  mocks.capabilities.mockResolvedValue(null);
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
it("lists /blog once an article is published, and never the articles themselves", async () => {
  mocks.counts.mockResolvedValue({ counts: {}, total: 0 });
  const empty = await buildStaticSitemap();
  expect(empty.some((e) => e.url === SITE_URL + "/blog")).toBe(false);

  mocks.blogEntries.mockResolvedValue([
    {
      articleId: "a1",
      canonicalUrl: null,
      locale: "en",
      publishedAt: null,
      updatedAt: null,
      urlPath: "/blog/hello",
    },
  ]);
  const withPost = await buildStaticSitemap();
  expect(withPost.some((e) => e.url === SITE_URL + "/blog")).toBe(true);
  // Articles live in the blog sitemap; listing them here too would submit
  // every article URL twice.
  expect(withPost.some((e) => e.url === SITE_URL + "/blog/hello")).toBe(false);
});
it("lists /pricing only when checkout is available", async () => {
  mocks.counts.mockResolvedValue({ counts: {}, total: 0 });
  const none = await buildStaticSitemap();
  expect(none.some((e) => e.url === SITE_URL + "/pricing")).toBe(false);

  mocks.capabilities.mockResolvedValue({
    edition: "commercial",
    billing: { checkout: false },
  });
  const noCheckout = await buildStaticSitemap();
  expect(noCheckout.some((e) => e.url === SITE_URL + "/pricing")).toBe(false);

  mocks.capabilities.mockResolvedValue({
    edition: "commercial",
    billing: { checkout: true },
  });
  const withCheckout = await buildStaticSitemap();
  expect(withCheckout.some((e) => e.url === SITE_URL + "/pricing")).toBe(true);
});
it("lists the About & method page with its three languages", async () => {
  mocks.counts.mockResolvedValue({ counts: {}, total: 0 });
  const entries = await buildStaticSitemap();
  const method = entries.filter((e) => e.url === SITE_URL + "/about/method");
  expect(method).toHaveLength(1);
  expect(method[0]?.alternates?.languages).toEqual({
    en: SITE_URL + "/about/method",
    "zh-CN": SITE_URL + "/zh-CN/about/method",
    "zh-TW": SITE_URL + "/zh-TW/about/method",
  });
  expect(method[0]?.lastModified).toBeUndefined();
});
