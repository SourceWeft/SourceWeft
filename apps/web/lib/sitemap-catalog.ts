import "server-only";
import { unstable_cache } from "next/cache";
import { cache } from "react";
import { MarketClient, type CatalogSitemapKind } from "@sourceweft/market-sdk";
import { apiBaseUrl } from "./api-base-url";

// No empty-list fallback: cache only complete, schema-validated responses.
export const getPublicSitemapIndex = unstable_cache(
  () => new MarketClient({ baseUrl: apiBaseUrl }).getSitemapIndex(),
  ["public-sitemap-index"],
  { revalidate: 60 },
);
// Shards may exceed Next's 2MB persistent data-cache limit. Keep request-local
// deduplication here; the complete XML response carries HTTP cache headers.
export const getPublicSitemapShard = cache(
  (kind: CatalogSitemapKind, prefix: string) =>
    new MarketClient({ baseUrl: apiBaseUrl }).getSitemapShard(kind, prefix),
);
