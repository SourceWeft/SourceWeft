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
  type MarketMcpProductGroup,
  type MarketMcpReadme,
  type MarketMcpScore,
  type MarketCategoryCountsResponse,
  type ListMarketCategoriesResponse,
  type ListMarketMcpRequest,
  type ListMarketMcpResponse,
  type ListMarketMcpToolRevisionsResponse,
  type MarketMcpToolsRevision,
} from "@sourceweft/market-sdk";

import type { Locale } from "@sourceweft/i18n/locales";
import { internalApiBaseUrl } from "./internal-api-base-url";
import { readMcpReadme } from "./mcp-readme";

const MCP_LIST_LIMIT = 100;

function marketClient() {
  // The MCP catalog is now served by the backend (sourceweft-api retired), so
  // the public read API lives at {backend}/v1/mcp — no separate service or
  // service token.
  return new MarketClient({ baseUrl: internalApiBaseUrl() });
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

// The locale is an argument, so it is part of each read's cache key.
const cachedListMcpCategories = unstable_cache(
  async (locale: Locale) => marketClient().listMcpCategories({ locale }),
  ["public-mcp-categories"],
  { revalidate: MCP_LIST_REVALIDATE_SECONDS },
);

/** The MCP categories, named and described in the page's language. */
export async function listPublicMcpCategories(
  locale: Locale,
): Promise<ListMarketCategoriesResponse> {
  try {
    return await cachedListMcpCategories(locale);
  } catch {
    return { items: [] };
  }
}

/**
 * Propagates market failures instead of returning an empty list. Category pages
 * must use this: with the swallowing variant an outage is indistinguishable
 * from "no such category" and would 404 every category page at once.
 */
export function requirePublicMcpCategories(
  locale: Locale,
): Promise<ListMarketCategoriesResponse> {
  return cachedListMcpCategories(locale);
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
  // False when the page stays out of search (`noindex, follow`); true when
  // the market says nothing or cannot be read, so an outage never deindexes.
  searchIndexable: boolean;
  // The servers integrating the same product, the product's own server
  // first (#367 W8); null when there is no such group or it cannot be read.
  relatedProduct: MarketMcpProductGroup | null;
  // The latest version's quality scorecard (Issue #367, W6); null when the
  // market has none or cannot be read, and the page shows no Score section.
  score: MarketMcpScore | null;
  // The current revision of the source whose tool list the page shows (Issue
  // #367, tool revisions); null when that list has no history or the market
  // cannot be read, and the page shows no change log.
  toolsRevision: MarketMcpToolsRevision | null;
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
      relatedProduct: detail.relatedProduct ?? null,
      score: detail.score ?? null,
      searchIndexable: detail.searchIndexable ?? true,
      toolsRevision: detail.toolsRevision ?? null,
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
      relatedProduct: null,
      score: null,
      searchIndexable: true,
      toolsRevision: null,
      versions: [],
    };
  }
}

const cachedMcpToolRevisions = unstable_cache(
  async (identifier: string) => marketClient().listMcpToolRevisions(identifier),
  ["public-mcp-tool-revisions"],
  { revalidate: MCP_DETAIL_REVALIDATE_SECONDS },
);

/**
 * The newest page of the change log of the tool list the page shows
 * (`GET /v1/mcp/:identifier/tools/revisions`); null when it cannot be read —
 * the page then goes without the change log.
 */
export async function getPublicMcpToolRevisions(
  identifier: string,
): Promise<ListMarketMcpToolRevisionsResponse | null> {
  try {
    return await cachedMcpToolRevisions(identifier);
  } catch {
    return null;
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
