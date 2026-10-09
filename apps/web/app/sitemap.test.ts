import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  index: vi.fn(),
  shard: vi.fn(),
  static: vi.fn(),
}));
vi.mock("../lib/sitemap-catalog", () => ({
  getPublicSitemapIndex: mocks.index,
  getPublicSitemapShard: mocks.shard,
}));
vi.mock("../lib/sitemap-static", () => ({ buildStaticSitemap: mocks.static }));
import { GET as index } from "./sitemap.xml/route";
import { GET as shard } from "./sitemap/[kind]/[file]/route";
import { SITE_URL } from "./seo";
import { catalogSitemapEntries } from "../lib/sitemap-entries";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.index.mockResolvedValue({ shards: [] });
  mocks.static.mockResolvedValue([{ url: SITE_URL + "/" }]);
});
it("uses an index with bounded shards beyond the former total cap", async () => {
  mocks.index.mockResolvedValue({
    shards: Array.from({ length: 16 }, (_, i) => ({
      kind: "skills",
      prefix: i.toString(16),
      count: 5000,
    })),
  });
  const response = await index();
  const xml = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/xml");
  expect(xml).toContain("<sitemapindex");
  expect(xml.match(/<sitemap>/g)).toHaveLength(17);
  expect(xml).toContain(`${SITE_URL}/sitemap-skills-f.xml`);
});
it("serves retained canonical slugs with actual overview languages only", async () => {
  mocks.shard.mockResolvedValue({
    items: [
      { key: "old-slug", updatedAt: null, overviewLocales: ["en", "zh-CN"] },
      { key: "english", updatedAt: null, overviewLocales: ["en"] },
    ],
  });
  const response = await shard(new Request("https://test"), {
    params: Promise.resolve({ kind: "skills", file: "a.xml" }),
  });
  const xml = await response.text();
  expect(xml).toContain(`${SITE_URL}/skills/old-slug`);
  expect(xml).toContain(`${SITE_URL}/zh-CN/skills/old-slug`);
  expect(xml).not.toContain("zh-CN/skills/english");
  expect(mocks.shard).toHaveBeenCalledWith("skills", "a");
  const mcp = catalogSitemapEntries("mcp", [
    {
      key: "io.github.o/tool",
      updatedAt: null,
      overviewLocales: ["en", "zh-TW"],
    },
  ]);
  expect(mcp[0]?.url).toBe(`${SITE_URL}/mcp/io.github.o%2Ftool`);
  expect(mcp[0]?.alternates?.languages?.["zh-TW"]).toContain("/zh-TW/mcp/");
});
it("returns no-store 503 on index or shard failure, never a partial sitemap", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.index.mockRejectedValue(new Error("offline"));
  const root = await index();
  expect(root.status).toBe(503);
  expect(root.headers.get("cache-control")).toBe("no-store");
  mocks.shard.mockRejectedValue(new Error("offline"));
  const child = await shard(new Request("https://test"), {
    params: Promise.resolve({ kind: "skills", file: "a.xml" }),
  });
  expect(child.status).toBe(503);
  log.mockRestore();
});
it("rejects invalid paths and missing static shards without a catalog query", async () => {
  for (const [kind, file] of [
    ["private", "a.xml"],
    ["skills", "a.json"],
    ["skills", "AA.xml"],
    ["static", "01.xml"],
    ["static", "9.xml"],
  ] as const)
    expect(
      (
        await shard(new Request("https://test"), {
          params: Promise.resolve({ kind, file }),
        })
      ).status,
    ).toBe(404);
  expect(mocks.shard).not.toHaveBeenCalled();
});
