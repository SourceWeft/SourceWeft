import { expect, it, vi } from "vitest";

vi.mock("../lib/blog-db", () => ({
  listPublishedBlogPosts: async () => [],
  listPublishedBlogSitemapEntries: async () => [],
}));
vi.mock("../lib/market-mcp", () => ({
  listPublicMcp: async () => ({ items: [], nextCursor: null }),
  listPublicMcpCategories: async () => ({ items: [] }),
}));
const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../lib/market-skills", () => ({
  listPublicSkills: mocks.list,
  listPublicSkillCategories: async () => ({ items: [] }),
  listPublicSkillCollections: async () => ({ items: [] }),
}));
import sitemap from "./sitemap";
import { SITE_URL } from "./seo";

it("uses actual overview languages on every catalog page, without requesting individual details", async () => {
  const skill = (slug: string, overviewLocales?: string[]) => ({
    slug,
    overviewLocales,
    listedAt: "2026-09-22",
    updatedAt: null,
  });
  mocks.list
    .mockResolvedValueOnce({
      items: [skill("translated", ["en", "zh-CN"])],
      nextCursor: "page2",
    })
    .mockResolvedValueOnce({
      items: [skill("english", ["en"]), skill("hidden", []), skill("legacy")],
      nextCursor: null,
    });
  const entries = await sitemap();
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(mocks.list.mock.calls[1]?.[0]).toMatchObject({
    cursor: "page2",
    sort: "new",
  });
  const translated = entries.find(
    (e) => e.url === `${SITE_URL}/skills/translated`,
  )!;
  expect(translated.alternates?.languages).toEqual({
    en: `${SITE_URL}/skills/translated`,
    "zh-CN": `${SITE_URL}/zh-CN/skills/translated`,
    "x-default": `${SITE_URL}/skills/translated`,
  });
  for (const slug of ["english", "hidden", "legacy"])
    expect(
      entries.find((e) => e.url === `${SITE_URL}/skills/${slug}`)?.alternates,
    ).toBeUndefined();
});
