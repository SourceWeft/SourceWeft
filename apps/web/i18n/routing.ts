import { DEFAULT_LOCALE, LOCALE_IDS } from "@sourceweft/i18n/locales";
import { defineRouting } from "next-intl/routing";

/**
 * Routing definition for the marketing tree only (`app/[locale]/…`). The app tree
 * (`/dashboard`, `/auth`, …) is intentionally left out of i18n routing — its locale
 * comes from the cookie/header, never the URL (design D3). `localePrefix: "as-needed"`
 * keeps the default locale prefix-free so existing URLs stay valid (D4).
 *
 * Wired into the router in Phase 1A when `app/[locale]` lands; defined here in Phase 0
 * so `request.ts`/`navigation.ts` can share one source of truth.
 */
export const routing = defineRouting({
  locales: LOCALE_IDS,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: "as-needed",
});
