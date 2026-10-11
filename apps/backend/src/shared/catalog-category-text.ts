import type { Locale } from "@sourceweft/i18n";
import { toTaiwanTraditional } from "@sourceweft/i18n/hant";

/** A catalog category's display name and description in one language. */
export type CatalogCategoryText = { name: string; description: string };

/**
 * A taxonomy category as the market defines it: English, plus the Simplified
 * Chinese translation every category must carry.
 */
export type TranslatedCatalogCategory = CatalogCategoryText & {
  zhCN: CatalogCategoryText;
};

const traditional = new Map<string, string>();

// Traditional Chinese is generated, never hand-written: OpenCC plus the shared
// glossary, exactly as the web catalogs are, so a category reads the same in
// the UI around it.
function toTraditional(text: string) {
  let converted = traditional.get(text);
  if (converted === undefined) {
    converted = toTaiwanTraditional(text);
    traditional.set(text, converted);
  }
  return converted;
}

/** A category's name and description in the reader's language. */
export function catalogCategoryText(
  category: TranslatedCatalogCategory,
  locale: Locale,
): CatalogCategoryText {
  if (locale === "zh-CN") return { ...category.zhCN };
  if (locale === "zh-TW") {
    return {
      name: toTraditional(category.zhCN.name),
      description: toTraditional(category.zhCN.description),
    };
  }
  return { name: category.name, description: category.description };
}
