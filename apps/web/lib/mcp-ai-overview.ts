import type {
  GetMcpOverviewAdminResponse,
  RegenerateMcpOverviewResponse,
  SetMcpOverviewHiddenResponse,
} from "@sourceweft/contracts";
import {
  marketMcpLocaleSchema,
  type MarketItemSummary,
  type MarketMcpAiOverview,
  type MarketMcpLocale,
} from "@sourceweft/market-contracts";
import { HttpClient } from "@sourceweft/sdk";

import { apiBaseUrl } from "./api-base-url";
import { catalogLocale } from "./i18n/catalog-locale";

/**
 * AI overviews of MCP servers (#152) on the web: the language to ask for,
 * what a card says, and the market admin's controls. The overviews themselves
 * come with the MCP detail (`aiOverview`) and list items (`aiSummary`,
 * `overviewLocales`). Admin routes answer 403 to everyone but a market admin.
 */

export type {
  GetMcpOverviewAdminResponse,
  MarketMcpAiOverview,
  MarketMcpLocale,
};

/** Languages the market writes MCP overviews in. */
export const MCP_OVERVIEW_LOCALES = marketMcpLocaleSchema.options;

/** The app's locale as one overviews are written in; English otherwise. */
export function mcpOverviewLocale(
  locale: string | null | undefined,
): MarketMcpLocale {
  return catalogLocale(locale);
}

/**
 * What a card says about an MCP server: the AI summary when the market has
 * one, else the registry's own summary — or, given the server's template
 * description (#367 W4, `mcpTemplateDescription`), that template where the
 * registry summary is not longer than it. Plain text either way.
 */
export function mcpCardText(
  item: Pick<MarketItemSummary, "summary" | "aiSummary">,
  template?: string | null,
): { text: string; ai: boolean } {
  const aiSummary = item.aiSummary?.trim();
  if (aiSummary) return { text: aiSummary, ai: true };
  const summary = item.summary.trim();
  const fallback = template?.trim();
  return fallback && summary.length <= fallback.length
    ? { text: fallback, ai: false }
    : { text: item.summary, ai: false };
}

const http = new HttpClient({ baseUrl: apiBaseUrl, credentials: "include" });

function adminPath(identifier: string) {
  return `/v1/market/admin/mcp/${encodeURIComponent(identifier)}/overview`;
}

// Market admins are one allowlist for skills and MCP servers alike; this is
// its check.
export { getSkillMarketAdminMe as getMarketAdminMe } from "./skill-overviews";

/** One server's overview in every language, and its generation state. */
export function getMcpOverviewAdmin(identifier: string) {
  return http.get<GetMcpOverviewAdminResponse>(adminPath(identifier));
}

/** Queues a fresh overview while the current one stays up. */
export function regenerateMcpOverview(identifier: string) {
  return http.post<RegenerateMcpOverviewResponse>(
    `${adminPath(identifier)}/regenerate`,
    {},
  );
}

/** Hides (or shows again) every language of the server's overview. */
export function setMcpOverviewHidden(identifier: string, hidden: boolean) {
  return http.post<SetMcpOverviewHiddenResponse>(
    `${adminPath(identifier)}/hidden`,
    { hidden },
  );
}
