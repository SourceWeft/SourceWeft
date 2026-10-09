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
    const [catalog, entries] = await Promise.all([
      getPublicSitemapIndex(),
      buildStaticSitemap(),
    ]);
    const staticShards = splitStaticSitemap(entries);
    return sitemapResponse(
      sitemapIndexXml([
        ...staticShards.map((_, i) => `${SITE_URL}/sitemap-static-${i}.xml`),
        ...catalog.shards.map(
          (s) => `${SITE_URL}/sitemap-${s.kind}-${s.prefix}.xml`,
        ),
      ]),
    );
  } catch (error) {
    return sitemapUnavailable(error);
  }
}
