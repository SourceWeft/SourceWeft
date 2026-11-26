import { listPublishedBlogSitemapEntries } from "../../lib/blog-db";
import { blogSitemapEntries } from "../../lib/sitemap-blog";
import { getPublicSitemapIndex } from "../../lib/sitemap-catalog";
import { buildStaticSitemap } from "../../lib/sitemap-static";
import {
  sitemapIndexXml,
  sitemapResponse,
  sitemapUnavailable,
  splitStaticSitemap,
} from "../../lib/sitemap-xml";
import { SITE_URL } from "../seo";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [catalog, entries, blogPosts] = await Promise.all([
      getPublicSitemapIndex(),
      buildStaticSitemap(),
      listPublishedBlogSitemapEntries(),
    ]);
    const staticShards = splitStaticSitemap(entries);
    // No file is listed while no article is published: an empty sitemap would
    // only be a URL for crawlers to fetch for nothing.
    const blogShards = splitStaticSitemap(blogSitemapEntries(blogPosts));
    return sitemapResponse(
      sitemapIndexXml([
        ...staticShards.map((_, i) => `${SITE_URL}/sitemap-static-${i}.xml`),
        ...blogShards.map((_, i) => `${SITE_URL}/sitemap-blog-${i}.xml`),
        ...catalog.shards.map(
          (s) => `${SITE_URL}/sitemap-${s.kind}-${s.prefix}.xml`,
        ),
      ]),
    );
  } catch (error) {
    return sitemapUnavailable(error);
  }
}
