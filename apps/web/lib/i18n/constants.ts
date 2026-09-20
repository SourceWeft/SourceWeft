/**
 * Shared constants for the locale plumbing. Kept dependency-free so both the
 * proxy (edge runtime) and server components can import them.
 */

/** Request header the proxy sets so the root layout and next-intl know the resolved locale (D6). */
export const SW_LOCALE_HEADER = "x-sw-locale";

/** Cookie the language switcher writes to persist an explicit choice (§5). */
export const SW_LOCALE_COOKIE = "sw_locale";

/** One year, in seconds — the locale cookie's lifetime. */
export const SW_LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
