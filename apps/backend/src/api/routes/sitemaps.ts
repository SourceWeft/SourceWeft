import type { Hono } from "hono";
import {
  catalogSitemapKindSchema,
  catalogSitemapPrefixSchema,
} from "@sourceweft/market-contracts";
import {
  readCatalogSitemapIndex,
  readCatalogSitemapShard,
} from "../../modules/catalog-sitemap/repository";
import { ApiError } from "../response/api-response";
import { cachedJson } from "../response/cached-json";

export function registerSitemapRoutes(app: Hono) {
  app.get("/v1/sitemaps", async (c) =>
    cachedJson(c, await readCatalogSitemapIndex(), { maxAge: 60 }),
  );
  app.get("/v1/sitemaps/:kind/:prefix", async (c) => {
    const kind = catalogSitemapKindSchema.safeParse(c.req.param("kind"));
    const prefix = catalogSitemapPrefixSchema.safeParse(c.req.param("prefix"));
    if (!kind.success || !prefix.success) throw ApiError.notFound();
    return cachedJson(
      c,
      await readCatalogSitemapShard(kind.data, prefix.data),
      { maxAge: 60 },
    );
  });
}
