import type { MetadataRoute } from "next";
import type {
  CatalogSitemapKind,
  CatalogSitemapShard,
} from "@sourceweft/market-sdk";
import { buildTranslatedAlternates } from "./i18n/metadata";
import { SITE_URL } from "../app/seo";
import { mcpPath } from "../app/[locale]/mcp/_components/mcp-display";
import { skillPath } from "../app/[locale]/skills/_components/skills-format";

export function catalogSitemapEntries(
  kind: CatalogSitemapKind,
  items: CatalogSitemapShard["items"],
): MetadataRoute.Sitemap {
  return items.map((item) => {
    const path = kind === "mcp" ? mcpPath(item.key) : skillPath(item.key);
    const { languages } = buildTranslatedAlternates(
      path,
      "en",
      item.overviewLocales,
    );
    const modified = item.updatedAt ? new Date(item.updatedAt) : null;
    return {
      url: `${SITE_URL}${path}`,
      changeFrequency: "weekly",
      priority: 0.55,
      ...(modified && !Number.isNaN(modified.getTime())
        ? { lastModified: modified }
        : {}),
      ...(languages ? { alternates: { languages } } : {}),
    };
  });
}
