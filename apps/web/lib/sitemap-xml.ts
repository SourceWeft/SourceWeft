import type { MetadataRoute } from "next";

export const SITEMAP_MAX_URLS = 50_000;
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;
const DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';
const URLSET =
  DECLARATION +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n';
const END = "</urlset>";

function escapeXml(value: string): string {
  // XML 1.0 forbids these code points; matching them is intentional.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value))
    throw new Error("Invalid XML character in sitemap");
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
}
function absoluteUrl(value: string) {
  if (!["https:", "http:"].includes(new URL(value).protocol))
    throw new Error("Sitemap URL must be absolute HTTP(S)");
  return escapeXml(value);
}
function entryXml(entry: MetadataRoute.Sitemap[number]): string {
  const fields = [`<loc>${absoluteUrl(entry.url)}</loc>`];
  if (entry.lastModified) {
    const date = new Date(entry.lastModified);
    if (Number.isNaN(date.getTime()))
      throw new Error("Invalid sitemap lastModified");
    fields.push(`<lastmod>${date.toISOString()}</lastmod>`);
  }
  if (entry.changeFrequency)
    fields.push(`<changefreq>${escapeXml(entry.changeFrequency)}</changefreq>`);
  if (entry.priority !== undefined) {
    if (
      !Number.isFinite(entry.priority) ||
      entry.priority < 0 ||
      entry.priority > 1
    )
      throw new Error("Invalid sitemap priority");
    fields.push(`<priority>${entry.priority}</priority>`);
  }
  for (const [language, href] of Object.entries(
    entry.alternates?.languages ?? {},
  )) {
    if (typeof href !== "string")
      throw new Error("Invalid sitemap alternate URL");
    fields.push(
      `<xhtml:link rel="alternate" hreflang="${escapeXml(language)}" href="${absoluteUrl(href)}"/>`,
    );
  }
  return `<url>${fields.join("")}</url>\n`;
}
function checkSize(xml: string) {
  if (Buffer.byteLength(xml, "utf8") > SITEMAP_MAX_BYTES)
    throw new Error("Sitemap exceeds byte limit");
  return xml;
}
export function sitemapXml(entries: MetadataRoute.Sitemap): string {
  if (entries.length > SITEMAP_MAX_URLS)
    throw new Error("Sitemap exceeds URL limit");
  return checkSize(URLSET + entries.map(entryXml).join("") + END);
}
export function sitemapIndexXml(urls: string[]): string {
  if (urls.length > SITEMAP_MAX_URLS)
    throw new Error("Sitemap index exceeds URL limit");
  if (new Set(urls).size !== urls.length)
    throw new Error("Duplicate sitemap index URL");
  return checkSize(
    DECLARATION +
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls
        .map((url) => `<sitemap><loc>${absoluteUrl(url)}</loc></sitemap>\n`)
        .join("") +
      "</sitemapindex>",
  );
}
/** Static/blog pages are also bounded, even if the editorial catalog grows. */
export function splitStaticSitemap(
  entries: MetadataRoute.Sitemap,
  target = 5_000,
  maxBytes = SITEMAP_MAX_BYTES,
): string[] {
  if (!Number.isInteger(target) || target < 1 || target > SITEMAP_MAX_URLS)
    throw new Error("Invalid sitemap shard size");
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > SITEMAP_MAX_BYTES
  )
    throw new Error("Invalid sitemap byte limit");
  const result: string[] = [];
  let rows: string[] = [];
  let bytes = Buffer.byteLength(URLSET + END);
  for (const entry of entries) {
    const row = entryXml(entry);
    const size = Buffer.byteLength(row);
    if (size + Buffer.byteLength(URLSET + END) > maxBytes)
      throw new Error("Sitemap entry exceeds byte limit");
    if (rows.length && (rows.length >= target || bytes + size > maxBytes)) {
      result.push(URLSET + rows.join("") + END);
      rows = [];
      bytes = Buffer.byteLength(URLSET + END);
    }
    rows.push(row);
    bytes += size;
  }
  if (rows.length) result.push(URLSET + rows.join("") + END);
  return result;
}
export function sitemapResponse(xml: string) {
  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=60, s-maxage=60",
    },
  });
}
export function sitemapUnavailable(error: unknown) {
  console.error("Sitemap generation failed", error);
  return new Response("Sitemap temporarily unavailable", {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });
}
