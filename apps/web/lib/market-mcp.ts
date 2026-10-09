import "server-only";

import { unstable_cache } from "next/cache";
import { cache } from "react";
import {
  MarketClient,
  MarketClientError,
  type GetMarketMcpManifestResponse,
  type GetMarketMcpResponse,
  type MarketMcpAiOverview,
  type MarketMcpLocale,
  type MarketMcpReadme,
  type MarketCategoryCountsResponse,
  type ListMarketCategoriesResponse,
  type ListMarketMcpRequest,
  type ListMarketMcpResponse,
} from "@sourceweft/market-sdk";

import { apiBaseUrl } from "./api-base-url";
import { readMcpReadme } from "./mcp-readme";

const MCP_LIST_LIMIT = 100;

function marketClient() {
  // The MCP catalog is now served by the backend (sourceweft-api retired), so
  // the public read API lives at {backend}/v1/mcp — no separate service or
  // service token.
  return new MarketClient({ baseUrl: apiBaseUrl });
}

export function isMarketNotFound(error: unknown) {
  return error instanceof MarketClientError && error.status === 404;
}

const MCP_LIST_REVALIDATE_SECONDS = 300;
const MCP_MANIFEST_REVALIDATE_SECONDS = 3600;

// The catalog is identical for every visitor, so it is cached across requests
// rather than re-fetched per crawl. Each cached callback rethrows on failure so
// that an outage is never stored as an empty catalog; the fallback lives in the
// exported wrapper, outside the cache.
const cachedListMcp = unstable_cache(
  // Web surfaces only web-executable (http/sse) servers; desktop-only entries
  // return when the desktop host ships.
  async (input: ListMarketMcpRequest) =>
    marketClient().listMcp({ limit: MCP_LIST_LIMIT, ...input }),
  ["public-mcp-list"],
  { revalidate: MCP_LIST_REVALIDATE_SECONDS },
);

export async function listPublicMcp(
  input: ListMarketMcpRequest = {},
): Promise<ListMarketMcpResponse> {
  try {
    return await cachedListMcp(input);
  } catch {
    return { items: [], nextCursor: null };
  }
}

const cachedListMcpCategories = unstable_cache(
  async () => marketClient().listMcpCategories(),
  ["public-mcp-categories"],
  { revalidate: MCP_LIST_REVALIDATE_SECONDS },
);

export async function listPublicMcpCategories(): Promise<ListMarketCategoriesResponse> {
  try {
    return await cachedListMcpCategories();
  } catch {
    return { items: [] };
  }
}

/**
 * Propagates market failures instead of returning an empty list. Category pages
 * must use this: with the swallowing variant an outage is indistinguishable
 * from "no such category" and would 404 every category page at once.
 */
export function requirePublicMcpCategories(): Promise<ListMarketCategoriesResponse> {
  return cachedListMcpCategories();
}

const cachedMcpCategoryCounts = unstable_cache(
  async (input: Parameters<MarketClient["countMcpByCategory"]>[0]) =>
    marketClient().countMcpByCategory(input),
  ["public-mcp-category-counts"],
  { revalidate: MCP_LIST_REVALIDATE_SECONDS },
);

/** Strict count read for surfaces that distinguish an outage from an empty catalog. */
export function requirePublicMcpCounts(
  input: Parameters<MarketClient["countMcpByCategory"]>[0] = {},
): Promise<MarketCategoryCountsResponse> {
  return cachedMcpCategoryCounts(input);
}

export async function countPublicMcpByCategory(
  input: Parameters<MarketClient["countMcpByCategory"]>[0] = {},
): Promise<MarketCategoryCountsResponse> {
  try {
    return await cachedMcpCategoryCounts(input);
  } catch {
    return { counts: {}, total: 0 };
  }
}

export type PublicMcpDetail = {
  versions: GetMarketMcpResponse["versions"];
  readme: MarketMcpReadme | null;
  // The AI overview in the language asked for, English when there is none in
  // it; null when there is none to show.
  aiOverview: MarketMcpAiOverview | null;
  // The languages the server has a visible overview in, without fallback.
  overviewLocales: MarketMcpLocale[];
};

// A hidden or regenerated overview shows within about two minutes: this
// cache, then the API's own 60-second public cache in front of it.
const MCP_DETAIL_REVALIDATE_SECONDS = 60;

// The locale is an argument, so it is part of each read's cache key.
const cachedMcpDetail = unstable_cache(
  async (
    identifier: string,
    locale: MarketMcpLocale,
  ): Promise<PublicMcpDetail> => {
    const detail = await marketClient().getMcp(identifier, { locale });
    return {
      aiOverview: detail.aiOverview ?? null,
      overviewLocales: detail.item.overviewLocales ?? [],
      readme: readMcpReadme(detail),
      versions: detail.versions,
    };
  },
  ["public-mcp-detail"],
  { revalidate: MCP_DETAIL_REVALIDATE_SECONDS },
);

/**
 * The server's version history, README and AI overview in `locale`
 * (`GET /v1/mcp/:identifier`). All are extras on a page that the manifest
 * already makes: when they cannot be read, the page goes without them.
 */
export async function getPublicMcpDetail(
  identifier: string,
  locale: MarketMcpLocale,
): Promise<PublicMcpDetail> {
  try {
    return await cachedMcpDetail(identifier, locale);
  } catch {
    return {
      aiOverview: null,
      overviewLocales: [],
      readme: null,
      versions: [],
    };
  }
}

const cachedMcpManifest = unstable_cache(
  async (identifier: string) => marketClient().getMcpManifest(identifier),
  ["public-mcp-manifest"],
  { revalidate: MCP_MANIFEST_REVALIDATE_SECONDS },
);

// `cache` dedupes the generateMetadata + page render pair within one request.
export const getPublicMcpManifest = cache(
  (identifier: string): Promise<GetMarketMcpManifestResponse> =>
    cachedMcpManifest(identifier),
);
