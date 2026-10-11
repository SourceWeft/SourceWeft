import { getTranslations } from "next-intl/server";
import { DEFAULT_LOCALE, type Locale } from "@sourceweft/i18n/locales";

type Category = { slug: string; name: string; description: string | null };

/**
 * Catalog categories named and described in the page's language. English
 * stays the market taxonomy's own wording (en.json mirrors it only to keep the
 * catalogs aligned); other locales overlay the `marketCategories` catalog by
 * slug, and a category it does not know yet keeps the market's English rather
 * than going missing.
 */
export async function localizeMarketCategories<T extends Category>(
  kind: "mcp" | "skills",
  items: readonly T[],
  locale: Locale,
): Promise<T[]> {
  if (locale === DEFAULT_LOCALE) return [...items];
  const t = await getTranslations({
    locale,
    namespace: `marketCategories.${kind}`,
  });
  return items.map((item) =>
    t.has(`${item.slug}.name`)
      ? {
          ...item,
          name: t(`${item.slug}.name`),
          description: t(`${item.slug}.description`),
        }
      : item,
  );
}
