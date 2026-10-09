import { expect, it } from "vitest";
import { sitemapXml, sitemapIndexXml, splitStaticSitemap } from "./sitemap-xml";
it("escapes XML URLs and alternates without changing their meaning", () => {
  const xml = sitemapXml([
    {
      url: "https://example.com/a?x=1&y=2",
      alternates: {
        languages: { "zh-CN": 'https://example.com/zh?x="yes"&y=2' },
      },
    },
  ]);
  expect(xml).toContain("x=1&amp;y=2");
  expect(xml).toContain("x=&quot;yes&quot;&amp;y=2");
  expect(() => sitemapXml([{ url: "javascript:bad" }])).toThrow();
  expect(() => sitemapXml([{ url: "https://example.com/\u0001" }])).toThrow(
    "Invalid XML character",
  );
  expect(() =>
    sitemapIndexXml(["https://example.com/a", "https://example.com/a"]),
  ).toThrow("Duplicate");
});
it("partitions editorial catalogs without omitting URLs and rejects protocol overflow", () => {
  const entries = Array.from({ length: 5001 }, (_, i) => ({
    url: `https://example.com/blog/${i}`,
  }));
  const pages = splitStaticSitemap(entries);
  expect(pages).toHaveLength(2);
  expect(pages[0]?.match(/<url>/g)).toHaveLength(5000);
  expect(pages[1]).toContain("/blog/5000");
  expect(() => sitemapXml(Array(50001).fill(entries[0]))).toThrow("URL limit");
  expect(() =>
    sitemapIndexXml(
      Array.from({ length: 50001 }, (_, i) => `https://example.com/${i}`),
    ),
  ).toThrow("URL limit");
});

it("measures UTF-8 bytes and escaped content before placing static entries", () => {
  const entry = { url: "https://example.com/漢字?a=1&b=2" };
  const one = Buffer.byteLength(sitemapXml([entry]));
  expect(splitStaticSitemap([entry, entry], 5000, one)).toHaveLength(2);
  expect(() => splitStaticSitemap([entry], 5000, one - 1)).toThrow(
    "byte limit",
  );
});
