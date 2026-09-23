import { deepMergeMessages } from "@sourceweft/i18n/catalog";
import {
  DEFAULT_LOCALE,
  isLocale,
  type Locale,
} from "@sourceweft/i18n/locales";
import { getBillingMessages } from "@sourceweft/billing/messages";
import { headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";

import en from "../messages/en.json";

import { SW_LOCALE_HEADER } from "../lib/i18n/constants";

/** English is the baseline for every individual key, even in partial catalogs. */
async function loadMessages(locale: Locale): Promise<Record<string, unknown>> {
  if (locale === DEFAULT_LOCALE) return en;
  try {
    const translated = (await import(`../messages/${locale}.json`)).default;
    return deepMergeMessages(en, translated);
  } catch {
    // Translation availability must never prevent the application from loading.
    return en;
  }
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
      pricing: deepMergeMessages(
        getBillingMessages("en"),
        getBillingMessages(locale),
      ),
    },
    // A fixed default keeps server-rendered dates hydration-stable; user-facing
    // times are already formatted client-side in their own timezone.
    timeZone: "UTC",
  };
});
