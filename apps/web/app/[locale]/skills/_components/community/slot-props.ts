import type { Locale } from "@sourceweft/i18n/locales";

/** What the public skill page hands each community slot. */
export type PublicSkillSlotProps = {
  slug: string;
  signedIn: boolean;
  // The page's UI locale; AI overviews are read in it (en fallback).
  locale: Locale;
};
