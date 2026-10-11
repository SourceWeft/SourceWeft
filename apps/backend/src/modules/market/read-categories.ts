import type { Locale } from "@sourceweft/i18n";
import type { MarketCategory } from "@sourceweft/market-contracts";
import { catalogCategoryText } from "../../shared/catalog-category-text";
import { mcpCategoryDefinitions } from "./taxonomy";

/** The MCP categories, named and described in the reader's language. */
export function listMcpCategories(locale: Locale = "en"): {
  items: MarketCategory[];
} {
  return {
    items: mcpCategoryDefinitions.map((category) => ({
      id: `mcp-cat-${category.slug}`,
      slug: category.slug,
      ...catalogCategoryText(category, locale),
    })),
  };
}
