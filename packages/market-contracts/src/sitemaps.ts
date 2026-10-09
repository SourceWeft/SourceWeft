import { z } from "zod";

export const catalogSitemapKindSchema = z.enum(["mcp", "skills"]);
export const catalogSitemapPrefixSchema = z.string().regex(/^[0-9a-f]{1,32}$/);
export const CATALOG_SITEMAP_TARGET_SIZE = 5_000;
export const SITEMAP_MAX_URLS = 50_000;
export const catalogSitemapIndexSchema = z.object({
  shards: z
    .array(
      z.object({
        kind: catalogSitemapKindSchema,
        prefix: catalogSitemapPrefixSchema,
        count: z.number().int().positive().max(CATALOG_SITEMAP_TARGET_SIZE),
      }),
    )
    .max(SITEMAP_MAX_URLS),
});
export const catalogSitemapShardSchema = z.object({
  items: z
    .array(
      z.object({
        key: z.string().min(1),
        updatedAt: z.string().nullable(),
        overviewLocales: z.array(z.enum(["en", "zh-CN", "zh-TW"])),
      }),
    )
    .max(SITEMAP_MAX_URLS),
});
export type CatalogSitemapKind = z.infer<typeof catalogSitemapKindSchema>;
export type CatalogSitemapIndex = z.infer<typeof catalogSitemapIndexSchema>;
export type CatalogSitemapShard = z.infer<typeof catalogSitemapShardSchema>;
