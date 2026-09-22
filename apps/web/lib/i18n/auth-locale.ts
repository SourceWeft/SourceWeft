import type { AuthLocale } from "@better-auth-ui/core";
import type { Locale } from "@sourceweft/i18n/locales";
import type en from "../../messages/en.json";

export type AuthLocaleMessages = typeof en.authLocale;

/** Raw messages: Better Auth, not ICU, interpolates its {{placeholders}}. */
export function buildAuthLocale(
  locale: Locale,
  messages: AuthLocaleMessages,
): AuthLocale {
  return {
    languageTag: locale,
    direction: "ltr",
    localization: messages.core,
    plugins: messages.plugins,
  };
}
