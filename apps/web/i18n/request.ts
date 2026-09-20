import { getFallbackChain } from "@sourceweft/i18n/catalog";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@sourceweft/i18n/locales";
import { getBillingMessages } from "@sourceweft/billing/messages";
import { headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";

import { SW_LOCALE_HEADER } from "../lib/i18n/constants";

/**
 * next-intl request config. We run *without* i18n routing (the app tree has no
 * `[locale]` segment, D3), so the locale is not taken from a URL param — it is
 * read from the `x-sw-locale` request header that the proxy computes for every
 * request (D6). The marketing `[locale]` tree overrides this per-segment in
 * Phase 1A.
 *
 * Messages are loaded with an English backstop (`getFallbackChain`): a key missing
 * from a translation renders the English string rather than a raw key. In Phase 0
 * only `en.json` exists, so every locale resolves to the English catalog.
 */
async function loadMessages(locale: Locale): Promise<Record<string, unknown>> {
  for (const candidate of getFallbackChain(locale)) {
    try {
      return (await import(`../messages/${candidate}.json`)).default;
    } catch {
      // Fall through to the next locale in the chain (a catalog may not exist yet).
    }
  }
  return {};
}

export default getRequestConfig(async ({ requestLocale }) => {
  // Marketing pages under `app/[locale]` set the segment locale via
  // `setRequestLocale`; the app tree has no segment, so we fall back to the
  // proxy-set header (D6). Either way the value is validated before use.
  const segmentLocale = await requestLocale;
  const headerLocale = (await headers()).get(SW_LOCALE_HEADER);
  const locale: Locale = isLocale(segmentLocale)
    ? segmentLocale
    : isLocale(headerLocale)
      ? headerLocale
      : DEFAULT_LOCALE;

  return {
    locale,
    // The pricing card copy lives in the licensed billing package (D8/§20); it
    // is a fresh top-level namespace, so a shallow add is enough.
    messages: {
      ...(await loadMessages(locale)),
      pricing: getBillingMessages(locale),
    },
    // A fixed default keeps server-rendered dates hydration-stable; user-facing
    // times are already formatted client-side in their own timezone.
    timeZone: "UTC",
  };
});
