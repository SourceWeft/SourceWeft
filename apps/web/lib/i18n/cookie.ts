import type { Locale } from "@sourceweft/i18n/locales";

import { SW_LOCALE_COOKIE, SW_LOCALE_COOKIE_MAX_AGE } from "./constants";

/**
 * Client-side helpers for the explicit locale cookie. The cookie is intentionally
 * NOT HttpOnly so the language switcher can read/write it (§5). The proxy reads it
 * on the next request to resolve the locale.
 */

export function setLocaleCookie(locale: Locale) {
  if (typeof document === "undefined") {
    return;
  }
  document.cookie = `${SW_LOCALE_COOKIE}=${locale}; path=/; max-age=${SW_LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
}

export function clearLocaleCookie() {
  if (typeof document === "undefined") {
    return;
  }
  document.cookie = `${SW_LOCALE_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

/** The raw cookie value, if one is currently pinned (`null` otherwise). Lets a
 * caller tell "nothing to do" apart from "this needs a refresh to take
 * effect" without guessing at what the last render actually used. */
export function getLocaleCookie(): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${SW_LOCALE_COOKIE}=([^;]*)`),
  );
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
