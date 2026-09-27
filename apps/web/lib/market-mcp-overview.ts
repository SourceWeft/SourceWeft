import "server-only";

import { unstable_cache } from "next/cache";
import { cache } from "react";
import { DEFAULT_LOCALE } from "@sourceweft/i18n/locales";
import { HttpClient } from "@sourceweft/sdk";

import { apiBaseUrl } from "./api-base-url";
import {
  MCP_OVERVIEW_LOCALES,
  readMcpOverviewDetail,
  type MarketMcpOverviewLocale,
  type McpOverviewDetail,
} from "./mcp-ai-overview";

/**
 * MCP AI overviews for the public pages, read from the public detail
 * (`GET /v1/mcp/:identifier?locale=`).
 *
 * Read over plain HTTP rather than `MarketClient.getMcp`: that method sends no
 * locale, and its response schema strips `aiOverview` and the item's
 * `overviewLocales`. TODO(#152): read through the market SDK once C2's
 * contract lands.
 */
const http = new HttpClient({ baseUrl: apiBaseUrl });

// A regenerated or hidden overview shows within about two minutes: this
// cache, then the API's own 60-second public cache in front of it.
const MCP_OVERVIEW_REVALIDATE_SECONDS = 60;

const NO_OVERVIEW: McpOverviewDetail = {
  aiOverview: null,
  overviewLocales: null,
};

// The locale is an argument, so it is part of each read's cache key. Rethrows
// on failure so an outage is never cached as "no overview".
const cachedOverview = unstable_cache(
  async (
    identifier: string,
    locale: MarketMcpOverviewLocale,
  ): Promise<McpOverviewDetail> =>
    readMcpOverviewDetail(
      await http.get<unknown>(
        `/v1/mcp/${encodeURIComponent(identifier)}?locale=${encodeURIComponent(locale)}`,
      ),
    ),
  ["public-mcp-ai-overview"],
  { revalidate: MCP_OVERVIEW_REVALIDATE_SECONDS },
);

/**
 * The server's AI overview in `locale` (English when there is none in it).
 * An extra on a page the manifest already makes: when it cannot be read, the
 * page goes without it. `cache` dedupes the metadata and body reads within
 * one request.
 */
export const getPublicMcpAiOverview = cache(
  async (
    identifier: string,
    locale: MarketMcpOverviewLocale,
  ): Promise<McpOverviewDetail> => {
    try {
      return await cachedOverview(identifier, locale);
    } catch {
      return NO_OVERVIEW;
    }
  },
);

/**
 * The non-default languages the server has a visible overview in, for
 * hreflang. The item's own `overviewLocales` when the detail names them;
 * otherwise each language is asked for in turn, and — as the API falls back
 * to English — only an answer in that language counts. A failed read counts
 * as none, so no language is ever listed that the API did not report.
 */
export async function getPublicMcpOverviewLocales(
  identifier: string,
): Promise<MarketMcpOverviewLocale[]> {
  const candidates = MCP_OVERVIEW_LOCALES.filter((id) => id !== DEFAULT_LOCALE);
  const { overviewLocales } = await getPublicMcpAiOverview(
    identifier,
    DEFAULT_LOCALE,
  );
  if (overviewLocales) {
    return candidates.filter((id) => overviewLocales.includes(id));
  }
  const found = await Promise.all(
    candidates.map(
      async (id) =>
        (await getPublicMcpAiOverview(identifier, id)).aiOverview?.locale ===
        id,
    ),
  );
  return candidates.filter((_, index) => found[index]);
}
