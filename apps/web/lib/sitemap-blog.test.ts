import { expect, it } from "vitest";

import type { BlogSitemapEntry } from "./blog-db";
import { blogSitemapEntries } from "./sitemap-blog";
import { sitemapXml } from "./sitemap-xml";
import { SITE_URL } from "../app/seo";

function entry(overrides: Partial<BlogSitemapEntry> = {}): BlogSitemapEntry {
  return {
    articleId: "what-is-mcp",
    canonicalUrl: null,
    locale: "en",
    publishedAt: new Date("2026-11-20T00:00:00.000Z"),
    slug: "what-is-mcp",
    updatedAt: null,
    urlPath: "/blog/what-is-mcp",
    ...overrides,
  };
}

it("uses the article's update date, then its publish date, and never a made-up one", () => {
  const [updated, publishedOnly, undated] = blogSitemapEntries([
    entry({ updatedAt: new Date("2026-11-22T08:30:00.000Z") }),
    entry({ articleId: "b", slug: "b", urlPath: "/blog/b" }),
    entry({
      articleId: "c",
      publishedAt: null,
      slug: "c",
      urlPath: "/blog/c",
    }),
  ]);
  expect(updated?.lastModified).toEqual(new Date("2026-11-22T08:30:00.000Z"));
  expect(publishedOnly?.lastModified).toEqual(
    new Date("2026-11-20T00:00:00.000Z"),
  );
  expect(undated && "lastModified" in undated).toBe(false);
  expect(sitemapXml([undated!])).not.toContain("<lastmod>");
});

it("lists only articles whose canonical is their own URL", () => {
  const entries = blogSitemapEntries([
    entry(),
    entry({
      articleId: "self",
      canonicalUrl: `${SITE_URL}/blog/self`,
      slug: "self",
      urlPath: "/blog/self",
    }),
    entry({
      articleId: "elsewhere",
      canonicalUrl: "https://example.com/original",
      slug: "elsewhere",
      urlPath: "/blog/elsewhere",
    }),
    entry({
      articleId: "broken",
      canonicalUrl: "http://[broken",
      slug: "broken",
      urlPath: "/blog/broken",
    }),
  ]);
  expect(entries.map((item) => item.url)).toEqual([
    `${SITE_URL}/blog/what-is-mcp`,
    `${SITE_URL}/blog/self`,
  ]);
});

it("links only the translations that are listed themselves", () => {
  const entries = blogSitemapEntries([
    entry(),
    entry({
      locale: "zh-CN",
      slug: "what-is-mcp-zh-cn",
      urlPath: "/zh-CN/blog/what-is-mcp-zh-cn",
    }),
    entry({
      canonicalUrl: "https://example.com/original",
      locale: "zh-TW",
      slug: "what-is-mcp-zh-tw",
      urlPath: "/zh-TW/blog/what-is-mcp-zh-tw",
    }),
    entry({ articleId: "solo", slug: "solo", urlPath: "/blog/solo" }),
  ]);
  expect(entries).toHaveLength(3);
  expect(entries[0]?.alternates?.languages).toEqual({
    en: `${SITE_URL}/blog/what-is-mcp`,
    "zh-CN": `${SITE_URL}/zh-CN/blog/what-is-mcp-zh-cn`,
  });
  // A single-language article carries no hreflang at all.
  expect(entries[2]?.alternates).toBeUndefined();
});

it("lists each URL once", () => {
  const urls = blogSitemapEntries([
    entry(),
    entry({
      locale: "zh-CN",
      slug: "what-is-mcp-zh-cn",
      urlPath: "/zh-CN/blog/what-is-mcp-zh-cn",
    }),
  ]).map((item) => item.url);
  expect(new Set(urls).size).toBe(urls.length);
});
