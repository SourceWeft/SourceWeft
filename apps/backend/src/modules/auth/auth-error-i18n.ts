import { locales, type TranslationDictionary } from "@better-auth/i18n";
import type { GenericEndpointContext } from "@better-auth/core";
import { isLocale, type Locale } from "@sourceweft/i18n";

// The web layer conveys the active locale (design §16) on every auth request via
// the `x-sw-locale` header and the `sw_locale` cookie; the browser also always
// sends `Accept-Language`.
export const AUTH_LOCALE_HEADER = "x-sw-locale";
export const AUTH_LOCALE_COOKIE = "sw_locale";

// Traditional Chinese error messages. The official @better-auth/i18n plugin
// ships Simplified Chinese only (`locales.zh`, 34 error codes) and no
// Traditional pack, so this dictionary is generated from `locales.zh` with
// OpenCC (cn -> twp, Taiwan standard + phrases) plus the shared product-term
// glossary — the exact pipeline the web catalogs use
// (apps/web/scripts/i18n-hant.mjs, design §8 D7 / §16). Regenerate this table
// from `locales.zh` whenever the plugin's Simplified pack changes; do not
// hand-edit individual entries.
const zhTW: TranslationDictionary = {
  USER_NOT_FOUND: "使用者未找到",
  FAILED_TO_CREATE_USER: "建立使用者失敗",
  FAILED_TO_CREATE_SESSION: "建立會話失敗",
  FAILED_TO_UPDATE_USER: "更新使用者失敗",
  FAILED_TO_GET_SESSION: "獲取會話失敗",
  INVALID_PASSWORD: "密碼無效",
  INVALID_EMAIL: "郵箱無效",
  INVALID_EMAIL_OR_PASSWORD: "郵箱或密碼無效",
  INVALID_USER: "使用者無效",
  SOCIAL_ACCOUNT_ALREADY_LINKED: "社交帳戶已繫結",
  PROVIDER_NOT_FOUND: "提供商未找到",
  INVALID_TOKEN: "令牌無效",
  TOKEN_EXPIRED: "令牌已過期",
  FAILED_TO_GET_USER_INFO: "獲取使用者資訊失敗",
  USER_EMAIL_NOT_FOUND: "使用者郵箱未找到",
  EMAIL_NOT_VERIFIED: "郵箱未驗證",
  PASSWORD_TOO_SHORT: "密碼太短",
  PASSWORD_TOO_LONG: "密碼太長",
  USER_ALREADY_EXISTS: "使用者已存在",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "使用者已存在，請使用其他郵箱",
  EMAIL_CAN_NOT_BE_UPDATED: "郵箱無法更新",
  CREDENTIAL_ACCOUNT_NOT_FOUND: "憑證帳戶未找到",
  SESSION_EXPIRED: "會話已過期，請重新驗證身份以執行此操作",
  FAILED_TO_UNLINK_LAST_ACCOUNT: "無法取消繫結最後一個帳戶",
  ACCOUNT_NOT_FOUND: "帳戶未找到",
  USER_ALREADY_HAS_PASSWORD: "使用者已設定密碼，請提供密碼以刪除帳戶",
  VERIFICATION_EMAIL_NOT_ENABLED: "驗證郵件未啟用",
  EMAIL_ALREADY_VERIFIED: "郵箱已驗證",
  EMAIL_MISMATCH: "郵箱不匹配",
  SESSION_NOT_FRESH: "會話已過時",
  LINKED_ACCOUNT_ALREADY_EXISTS: "已繫結帳戶已存在",
  VALIDATION_ERROR: "驗證錯誤",
  MISSING_FIELD: "此欄位為必填項",
  PASSWORD_ALREADY_SET: "使用者已設定密碼",
};

/**
 * Error-message translations for the @better-auth/i18n plugin.
 *
 * `zh` is registered so the `header` (Accept-Language) strategy — which strips
 * the region subtag ("zh-CN"/"zh-TW" -> "zh") — still resolves to Simplified
 * Chinese for a Chinese-language browser even when no explicit locale is
 * conveyed. The explicit `x-sw-locale` header and `sw_locale` cookie carry the
 * full app locale and are what distinguish "zh-TW" (Traditional).
 */
export const authErrorTranslations = {
  en: locales.en,
  zh: locales.zh,
  "zh-CN": locales.zh,
  "zh-TW": zhTW,
};

/**
 * Locale detection order for the plugin (design §16, D11):
 *   1. `callback`  — the explicit `x-sw-locale` header the web auth client
 *                    attaches to every request; survives cross-origin calls
 *                    where the cookie is not sent.
 *   2. `cookie`    — the `sw_locale` cookie, for same-site requests.
 *   3. `header`    — `Accept-Language`, region stripped to Simplified `zh`.
 * Anything unresolved falls back to English (the raw better-auth message). The
 * UI keeps `localizeErrors={false}` and simply displays the already-localized
 * server message, so error text is localized in exactly one place.
 */
export const AUTH_ERROR_LOCALE_DETECTION = [
  "callback",
  "cookie",
  "header",
] as const;

/** `getLocale` callback: reads and validates the explicit `x-sw-locale` header. */
export function resolveAuthErrorLocale(
  ctx: GenericEndpointContext,
): Locale | null {
  const header = ctx.headers?.get(AUTH_LOCALE_HEADER);
  return isLocale(header) ? header : null;
}
