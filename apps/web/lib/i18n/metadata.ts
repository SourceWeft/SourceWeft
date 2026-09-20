import { DEFAULT_LOCALE, type Locale, LOCALE_IDS } from "@sourceweft/i18n/locales";
import { addLocalePrefix } from "@sourceweft/i18n/resolve";

import { SITE_URL } from "../../app/seo";

/**
 * Build the `alternates` block for a localized marketing page: a per-locale
 * `hreflang` set (default locale + `x-default` on the prefix-free URL, others
 * prefixed) and a `canonical` that points at *this* locale's URL. Every
 * localized route's `generateMetadata` uses this so hreflang and canonical can
 * never disagree (§9).
 */
export function buildAlternates(barePath: string, locale: Locale) {
  const urlFor = (id: Locale) => `${SITE_URL}${addLocalePrefix(barePath, id)}`;

  const languages: Record<string, string> = {};
  for (const id of LOCALE_IDS) {
    languages[id] = urlFor(id);
  }
  languages["x-default"] = urlFor(DEFAULT_LOCALE);

  return {
    canonical: urlFor(locale),
    languages,
  };
}

/**
 * `alternates.languages` for a `sitemap.ts` entry of a localized marketing route:
 * a hreflang map over the supported locales (the entry's own `url` stays the
 * prefix-free default). Only migrated routes pass this; content routes that are
 * not localized (blog/mcp/legal) omit it.
 */
export function sitemapLocaleAlternates(barePath: string) {
  const languages: Record<string, string> = {};
  for (const id of LOCALE_IDS) {
    languages[id] = `${SITE_URL}${addLocalePrefix(barePath, id)}`;
  }
  return { languages };
}
