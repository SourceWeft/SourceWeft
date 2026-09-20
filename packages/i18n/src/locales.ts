/**
 * The single source of truth for which locales the product supports and how each
 * one is spelled across the three places a locale identity leaks into: the URL
 * segment (`id`), the `<html lang>` attribute (`htmlLang`), and the BCP-47 tag
 * handed to `Intl.*` (`intlLocale`). Everything else — routing, negotiation,
 * formatting, the language switcher — reads this table, so adding a language is
 * a one-row change here (design decision D2/D9).
 */

/** Locale identifiers as they appear in a marketing URL segment (`/zh-CN/about`). */
export const LOCALE_IDS = ["en", "zh-CN", "zh-TW"] as const;

export type Locale = (typeof LOCALE_IDS)[number];

/** The locale rendered when nothing else is negotiated; it carries no URL prefix (D4). */
export const DEFAULT_LOCALE: Locale = "en";

export interface LocaleMeta {
  /** URL segment + cookie value + `user_settings.appearance.language`. */
  id: Locale;
  /** English name, for docs and admin surfaces. */
  label: string;
  /** Endonym, shown in the language switcher so each option reads in its own language. */
  nativeLabel: string;
  /** Text direction; all first-phase locales are LTR but the field is reserved for RTL (§1). */
  dir: "ltr" | "rtl";
  /** Value for `<html lang>`; also what CJK font CSS selectors key off (§10). */
  htmlLang: string;
  /** BCP-47 tag passed to every `Intl.*` constructor via the format module (§7). */
  intlLocale: string;
}

export const LOCALES: readonly LocaleMeta[] = [
  {
    id: "en",
    label: "English",
    nativeLabel: "English",
    dir: "ltr",
    htmlLang: "en",
    intlLocale: "en",
  },
  {
    id: "zh-CN",
    label: "Simplified Chinese",
    nativeLabel: "简体中文",
    dir: "ltr",
    htmlLang: "zh-CN",
    intlLocale: "zh-CN",
  },
  {
    id: "zh-TW",
    label: "Traditional Chinese",
    nativeLabel: "繁體中文",
    dir: "ltr",
    htmlLang: "zh-TW",
    intlLocale: "zh-TW",
  },
];

const LOCALE_META_BY_ID = new Map<Locale, LocaleMeta>(
  LOCALES.map((meta) => [meta.id, meta]),
);

/** Type guard: does `value` name one of our supported locales? */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && LOCALE_META_BY_ID.has(value as Locale);
}

/** Look up a locale's metadata; throws on an unknown id so callers fail loudly, not silently. */
export function getLocaleMeta(locale: Locale): LocaleMeta {
  const meta = LOCALE_META_BY_ID.get(locale);
  if (!meta) {
    throw new Error(`Unknown locale: ${String(locale)}`);
  }
  return meta;
}
