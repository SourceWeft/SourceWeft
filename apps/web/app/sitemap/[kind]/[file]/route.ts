import {
  catalogSitemapKindSchema,
  catalogSitemapPrefixSchema,
} from "@sourceweft/market-sdk";
import { getPublicSitemapShard } from "../../../../lib/sitemap-catalog";
import { buildStaticSitemap } from "../../../../lib/sitemap-static";
import { catalogSitemapEntries } from "../../../../lib/sitemap-entries";
import {
  sitemapResponse,
  sitemapUnavailable,
  sitemapXml,
  splitStaticSitemap,
} from "../../../../lib/sitemap-xml";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ kind: string; file: string }> },
) {
  const { kind, file } = await context.params;
  const missing = () =>
    new Response("Sitemap not found", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  try {
    if (kind === "static") {
      if (!/^(0|[1-9][0-9]{0,4})\.xml$/.test(file)) return missing();
      const pages = splitStaticSitemap(await buildStaticSitemap());
      const xml = pages[Number(file.slice(0, -4))];
      return xml === undefined ? missing() : sitemapResponse(xml);
    }
    const parsedKind = catalogSitemapKindSchema.safeParse(kind);
    const prefix = file.endsWith(".xml")
      ? catalogSitemapPrefixSchema.safeParse(file.slice(0, -4))
      : null;
    if (!parsedKind.success || !prefix?.success) return missing();
    const shard = await getPublicSitemapShard(parsedKind.data, prefix.data);
    return sitemapResponse(
      sitemapXml(catalogSitemapEntries(parsedKind.data, shard.items)),
    );
  } catch (error) {
    return sitemapUnavailable(error);
  }
}
