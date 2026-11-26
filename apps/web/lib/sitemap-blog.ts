import type { MetadataRoute } from "next";

import type { BlogSitemapEntry } from "./blog-db";
import { SITE_URL } from "../app/seo";

function ownUrl(entry: BlogSitemapEntry) {
  return `${SITE_URL}${entry.urlPath}`;
}

/**
 * The article page takes its canonical from the stored `canonical_url` when
 * one is set, and from its own URL otherwise. Only the second kind, or a
 * stored value that names the page itself, belongs in a sitemap.
 */
function isSelfCanonical(entry: BlogSitemapEntry) {
  if (!entry.canonicalUrl) {
    return true;
  }
  try {
    return new URL(entry.canonicalUrl, SITE_URL).toString() === ownUrl(entry);
  } catch {
    return false;
  }
}

/**
 * Sitemap entries for published articles. `entries` are the published rows in
 * routable languages, which are exactly the article URLs that answer 200
 * without a noindex; rows that point their canonical elsewhere are left out.
 * `lastModified` is the article's own update date, or its publish date when it
 * was never updated, and is omitted when neither is known.
 */
export function blogSitemapEntries(
  entries: BlogSitemapEntry[],
): MetadataRoute.Sitemap {
  const listed = entries.filter(isSelfCanonical);

  // hreflang links only the translations that are listed themselves.
  const urlsByArticle = new Map<string, Record<string, string>>();
  for (const entry of listed) {
    const group = urlsByArticle.get(entry.articleId) ?? {};
    group[entry.locale] = ownUrl(entry);
    urlsByArticle.set(entry.articleId, group);
  }

  return listed.map((entry) => {
    const languages = urlsByArticle.get(entry.articleId) ?? {};
    const modified = entry.updatedAt ?? entry.publishedAt;
    return {
      changeFrequency: "monthly" as const,
      ...(modified ? { lastModified: modified } : {}),
      priority: 0.5,
      url: ownUrl(entry),
      ...(Object.keys(languages).length > 1 ? { alternates: { languages } } : {}),
    };
  });
}
