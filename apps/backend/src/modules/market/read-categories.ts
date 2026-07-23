import type { MarketCategory } from "@sourceweft/market-contracts";
import { mcpCategoryDefinitions } from "./taxonomy";

export const canonicalMcpCategories: MarketCategory[] =
  mcpCategoryDefinitions.map((category) => ({
    id: `mcp-cat-${category.slug}`,
    slug: category.slug,
    name: category.name,
    description: category.description,
  }));

export function listMcpCategories() {
  return { items: canonicalMcpCategories };
}
