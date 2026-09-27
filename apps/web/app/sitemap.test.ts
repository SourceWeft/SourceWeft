import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../lib/blog-db", () => ({
  listPublishedBlogPosts: async () => [],
  listPublishedBlogSitemapEntries: async () => [],
}));
const mocks = vi.hoisted(() => ({ list: vi.fn(), listMcp: vi.fn() }));
vi.mock("../lib/market-mcp", () => ({
  listPublicMcp: mocks.listMcp,
  listPublicMcpCategories: async () => ({ items: [] }),
}));
vi.mock("../lib/market-skills", () => ({
  listPublicSkills: mocks.list,
  listPublicSkillCategories: async () => ({ items: [] }),
  listPublicSkillCollections: async () => ({ items: [] }),
}));
import sitemap from "./sitemap";
import { SITE_URL } from "./seo";

beforeEach(() => {
  mocks.listMcp.mockResolvedValue({ items: [], nextCursor: null });
  mocks.list.mockResolvedValue({ items: [], nextCursor: null });
});
afterEach(() => {
  vi.resetAllMocks();
});

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

it("lists an MCP server's other languages only where it has a visible overview in them", async () => {
  const server = (identifier: string, overviewLocales?: string[]) => ({
    categories: [],
    identifier,
    // What the list carries once the API adds it (#152).
    ...(overviewLocales ? { overviewLocales } : {}),
    updatedAt: "2026-09-22T00:00:00.000Z",
  });
  mocks.listMcp.mockResolvedValue({
    items: [
      server("io.github.o/translated", ["en", "zh-TW"]),
      server("io.github.o/english", ["en"]),
      server("io.github.o/legacy"),
    ],
    nextCursor: null,
  });
  const entries = await sitemap();
  const path = (identifier: string) => `/mcp/${encodeURIComponent(identifier)}`;
  const translated = entries.find(
    (e) => e.url === `${SITE_URL}${path("io.github.o/translated")}`,
  )!;
  expect(translated.alternates?.languages).toEqual({
    en: `${SITE_URL}${path("io.github.o/translated")}`,
    "zh-TW": `${SITE_URL}/zh-TW${path("io.github.o/translated")}`,
    "x-default": `${SITE_URL}${path("io.github.o/translated")}`,
  });
  for (const identifier of ["io.github.o/english", "io.github.o/legacy"]) {
    const entry = entries.find(
      (e) => e.url === `${SITE_URL}${path(identifier)}`,
    );
    expect(entry).toBeDefined();
    expect(entry?.alternates).toBeUndefined();
  }
});
