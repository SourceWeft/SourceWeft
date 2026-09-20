import { negotiateLocale, type Locale } from "@sourceweft/i18n";
import { AUTH_LOCALE_COOKIE, AUTH_LOCALE_HEADER } from "./auth-error-i18n";

/**
 * Resolves the locale to render an auth email in (design §16.7).
 *
 * Priority: the recipient's stored preference
 * (`user_settings.appearance.language`, when a userId is known and it is not the
 * pass-through value `"system"`), then the triggering request's signals — the
 * explicit `x-sw-locale` header, the `sw_locale` cookie, and `Accept-Language`.
 * `negotiateLocale` normalizes each candidate (e.g. `zh-HK` -> `zh-TW`) and
 * falls back to English, so a send never breaks or blocks on this and English
 * stays the default whenever nothing resolves.
 */
export async function resolveMailLocale(input: {
  userId?: string | null;
  headers?: Headers | null;
}): Promise<Locale> {
  const candidates: (string | null | undefined)[] = [];

  if (input.userId) {
    try {
      const { userSettingsService } = await import("../user-settings");
      const { settings } = await userSettingsService.getUserSettings({
        userId: input.userId,
      });
      const language = settings.appearance.language;
      // "system" means "follow the environment", so it is not a resolvable
      // locale — fall through to the request signals below.
      if (language && language !== "system") {
        candidates.push(language);
      }
    } catch {
      // A settings lookup failure must never block a transactional email;
      // fall through to the request-derived signals.
    }
  }

  const headers = input.headers;
  if (headers) {
    candidates.push(headers.get(AUTH_LOCALE_HEADER));
    candidates.push(readCookie(headers.get("cookie"), AUTH_LOCALE_COOKIE));
    candidates.push(headers.get("accept-language"));
  }

  return negotiateLocale(candidates);
}

function readCookie(
  cookieHeader: string | null | undefined,
  name: string,
): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}
