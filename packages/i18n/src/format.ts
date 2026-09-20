/**
 * The one place `Intl.*` is allowed to be constructed. Every date/number/currency
 * rendering goes through here so a locale is always supplied explicitly and no
 * component hard-codes `"en"` (the lint rule in §14 enforces the "no literal
 * locale" side of this). Instances are memoized because constructing `Intl`
 * formatters is comparatively expensive and these run in hot render paths.
 */

import { getLocaleMeta, type Locale } from "./locales";

const dateTimeCache = new Map<string, Intl.DateTimeFormat>();
const numberCache = new Map<string, Intl.NumberFormat>();
const relativeTimeCache = new Map<string, Intl.RelativeTimeFormat>();

function cacheKey(locale: Locale, options: unknown): string {
  return `${locale}\u0000${JSON.stringify(options ?? {})}`;
}

function dateTimeFormatter(
  locale: Locale,
  options?: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = cacheKey(locale, options);
  let formatter = dateTimeCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(getLocaleMeta(locale).intlLocale, options);
    dateTimeCache.set(key, formatter);
  }
  return formatter;
}

function numberFormatter(
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = cacheKey(locale, options);
  let formatter = numberCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(getLocaleMeta(locale).intlLocale, options);
    numberCache.set(key, formatter);
  }
  return formatter;
}

function relativeTimeFormatter(
  locale: Locale,
  options?: Intl.RelativeTimeFormatOptions,
): Intl.RelativeTimeFormat {
  const key = cacheKey(locale, options);
  let formatter = relativeTimeCache.get(key);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(
      getLocaleMeta(locale).intlLocale,
      options,
    );
    relativeTimeCache.set(key, formatter);
  }
  return formatter;
}

export function formatDate(
  value: Date | number,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions,
): string {
  return dateTimeFormatter(locale, options).format(value);
}

export function formatNumber(
  value: number | bigint,
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): string {
  return numberFormatter(locale, options).format(value);
}

/**
 * Currency defaults to USD because multi-language does not change pricing (D10);
 * only the display grouping/symbol placement follows the locale.
 */
export function formatCurrency(
  value: number | bigint,
  locale: Locale,
  currency = "USD",
  options?: Omit<Intl.NumberFormatOptions, "style" | "currency">,
): string {
  return numberFormatter(locale, { ...options, style: "currency", currency }).format(
    value,
  );
}

export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  locale: Locale,
  options?: Intl.RelativeTimeFormatOptions,
): string {
  return relativeTimeFormatter(locale, options).format(value, unit);
}
