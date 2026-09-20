/**
 * Locale negotiation and URL-prefix helpers shared by the Next proxy, the
 * language switcher, and the backend mail service. Pure functions, no framework
 * imports — the proxy composes them in the priority order fixed by §5
 * (URL prefix → cookie → user setting → Accept-Language → default).
 */

import {
  DEFAULT_LOCALE,
  isLocale,
  type Locale,
  LOCALE_IDS,
} from "./locales";

/**
 * Map an arbitrary BCP-47-ish tag onto one of our locales, or `null` if none fit.
 *
 * Chinese needs script/region folding: a browser may send `zh`, `zh-Hans`,
 * `zh-SG`, `zh-Hant`, `zh-HK`, `zh-MO`, etc. We collapse the Simplified family
 * to `zh-CN` and the Traditional family to `zh-TW` (D2), so `zh-HK` matches
 * Traditional rather than falling through to English.
 */
export function normalizeToLocale(tag: string | null | undefined): Locale | null {
  if (!tag) {
    return null;
  }

  const lower = tag.trim().toLowerCase();
  if (!lower) {
    return null;
  }

  // Exact match against a supported id (case-insensitive).
  const exact = LOCALE_IDS.find((id) => id.toLowerCase() === lower);
  if (exact) {
    return exact;
  }

  if (lower === "zh" || lower.startsWith("zh-") || lower.startsWith("zh_")) {
    const isTraditional =
      lower.includes("hant") ||
      lower.includes("-tw") ||
      lower.includes("-hk") ||
      lower.includes("-mo") ||
      lower.includes("_tw") ||
      lower.includes("_hk") ||
      lower.includes("_mo");
    return isTraditional ? "zh-TW" : "zh-CN";
  }

  if (lower === "en" || lower.startsWith("en-") || lower.startsWith("en_")) {
    return "en";
  }

  return null;
}

/**
 * Pick the best supported locale from an `Accept-Language` header, honouring
 * q-weights. Returns `null` when the header names nothing we support, so the
 * caller decides whether to fall back or only surface a "switch language" hint
 * (this never triggers a redirect on its own — D5).
 */
export function parseAcceptLanguage(
  header: string | null | undefined,
): Locale | null {
  if (!header) {
    return null;
  }

  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const q = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
      return { tag: tag?.trim() ?? "", q: Number.isFinite(q) ? q : 0 };
    })
    .filter((entry) => entry.tag && entry.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    const match = normalizeToLocale(tag);
    if (match) {
      return match;
    }
  }

  return null;
}

/**
 * Return the first candidate that resolves to a supported locale, falling back
 * to {@link DEFAULT_LOCALE}. Candidates are passed in the priority order of §5;
 * each may be a raw tag (it is normalized), and empty/unknown ones are skipped.
 */
export function negotiateLocale(
  candidates: readonly (string | null | undefined)[],
): Locale {
  for (const candidate of candidates) {
    const match = normalizeToLocale(candidate);
    if (match) {
      return match;
    }
  }
  return DEFAULT_LOCALE;
}

export interface StrippedPath {
  /** The locale named by the leading URL segment, or `null` if the path has none. */
  locale: Locale | null;
  /** The pathname with any locale segment removed, always starting with `/`. */
  pathname: string;
}

/**
 * Split a locale prefix off a pathname: `/zh-CN/about` → `{ "zh-CN", "/about" }`,
 * `/about` → `{ null, "/about" }`. Used by the proxy to detect the marketing-tree
 * locale and by the switcher to rewrite between languages.
 */
export function stripLocalePrefix(pathname: string): StrippedPath {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const slash = normalized.indexOf("/", 1);
  const firstSegment = normalized.slice(1, slash === -1 ? undefined : slash);

  if (isLocale(firstSegment)) {
    const rest = slash === -1 ? "" : normalized.slice(slash);
    return { locale: firstSegment, pathname: rest === "" ? "/" : rest };
  }

  return { locale: null, pathname: normalized };
}

/**
 * Prepend a locale segment to a pathname, except for the default locale which is
 * served without a prefix (`localePrefix: "as-needed"`, D4). Any existing locale
 * prefix is replaced, so this is safe to call on an already-localized path.
 */
export function addLocalePrefix(pathname: string, locale: Locale): string {
  const { pathname: bare } = stripLocalePrefix(pathname);
  if (locale === DEFAULT_LOCALE) {
    return bare;
  }
  return bare === "/" ? `/${locale}` : `/${locale}${bare}`;
}
