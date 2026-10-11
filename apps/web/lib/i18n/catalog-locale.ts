import {
  marketMcpLocaleSchema,
  type MarketMcpLocale,
} from "@sourceweft/market-contracts";

/**
 * The UI locale as one the catalog (MCP servers and skills alike) writes AI
 * overviews and category names in; English for anything else. Safe on the
 * client: server loaders and client components share this one mapping.
 */
export function catalogLocale(
  locale: string | null | undefined,
): MarketMcpLocale {
  const parsed = marketMcpLocaleSchema.safeParse(locale);
  return parsed.success ? parsed.data : "en";
}
