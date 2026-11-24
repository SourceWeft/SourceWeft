import type { Metadata } from "next";
import { LOCALES, type Locale } from "@sourceweft/i18n/locales";

/**
 * Open Graph locale codes (`language_TERRITORY`, underscore) for the supported
 * locales. `LocaleMeta.htmlLang` is a BCP-47 tag with a hyphen, which Open
 * Graph does not accept.
 */
const OG_LOCALE: Record<Locale, string> = {
  en: "en_US",
  "zh-CN": "zh_CN",
  "zh-TW": "zh_TW",
};

/**
 * `og:locale` for the page's language and `og:locale:alternate` for the other
 * supported ones. Detail pages share it so a locale added to `LOCALES` reaches
 * every one of them (the type forces a code for it).
 */
export function openGraphLocales(locale: Locale) {
  return {
    alternateLocale: LOCALES.filter((meta) => meta.id !== locale).map(
      (meta) => OG_LOCALE[meta.id],
    ),
    locale: OG_LOCALE[locale],
  };
}

/**
 * The explicit robots directive of an indexable detail page: say "index,
 * follow" and allow large image previews, rather than leave it to defaults.
 * A page that stays out of search spreads its own `NO_INDEX_*` metadata after
 * this, which replaces it whole.
 */
export const INDEXABLE_DETAIL_ROBOTS = {
  robots: {
    follow: true,
    index: true,
    "max-image-preview": "large",
  },
} as const satisfies Pick<Metadata, "robots">;
