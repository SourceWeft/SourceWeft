import { locales, type TranslationDictionary } from "@better-auth/i18n";
import type { GenericEndpointContext } from "@better-auth/core";
import { parseCookies } from "better-auth/cookies";
import { isLocale, type Locale } from "@sourceweft/i18n";
import { SSO_ERROR_CODES, SSO_ERROR_MESSAGES_EN } from "../enterprise-sso/errors";

// The web layer conveys the active locale (design §16) on every auth request via
// the `x-sw-locale` header and the `sw_locale` cookie; the browser also always
// sends `Accept-Language`.
export const AUTH_LOCALE_HEADER = "x-sw-locale";
export const AUTH_LOCALE_COOKIE = "sw_locale";

/**
 * Our own enterprise-SSO error messages (design §16 / task 7), keyed by
 * {@link SSO_ERROR_CODES} value so they merge into the plugin's own
 * translation tables below. `en` is {@link SSO_ERROR_MESSAGES_EN} itself —
 * errors.ts's single source of truth, also what every `guard-plugin.ts` /
 * `policy.ts` throw site uses via `ssoError`, so the untranslated and
 * `en`-translated text can never drift apart.
 */

/** Simplified Chinese counterpart of {@link SSO_ERROR_MESSAGES_EN}. */
const ssoErrorMessagesZhCN: TranslationDictionary = {
  [SSO_ERROR_CODES.providerNotFound]: "该邮箱未配置企业单点登录。",
  [SSO_ERROR_CODES.domainNotVerified]:
    "该域名尚未完成验证，请联系管理员完成配置。",
  [SSO_ERROR_CODES.domainNotAllowed]: "该域名不能用于单点登录。",
  [SSO_ERROR_CODES.accountLinkDenied]:
    "无法将此登录关联到已有账号，请联系管理员。",
  [SSO_ERROR_CODES.seatLimit]: "团队席位已满，请联系管理员增加席位。",
  [SSO_ERROR_CODES.provisioningFailed]:
    "无法将你加入团队，请重试或联系管理员。",
  [SSO_ERROR_CODES.invalidRoleAttribute]:
    "该角色属性名不可用，请换一个属性。",
  [SSO_ERROR_CODES.invalidAttributeMapping]:
    "该属性映射使用了保留的字段名，请换一个字段名。",
  [SSO_ERROR_CODES.invalidProviderId]:
    "身份源 ID 需为 3–47 个小写字母、数字或连字符，且不能与内置登录方式同名。",
  [SSO_ERROR_CODES.organizationRequired]: "单点登录只能为团队配置。",
  [SSO_ERROR_CODES.providerLimit]: "该团队的身份源数量已达上限（5 个）。",
  [SSO_ERROR_CODES.providerIdentityLocked]:
    "已有成员使用该身份源登录后，这些设置不能再修改。如需修改，请先删除该身份源，再重新配置。",
  [SSO_ERROR_CODES.samlAlgorithmNotAllowed]:
    "身份源返回的 SAML 响应使用了不支持的签名设置。请联系管理员改用 SHA-256 签名，并发送未加密的断言。",
};

/**
 * Traditional Chinese (Taiwan) counterpart of {@link ssoErrorMessagesZhCN},
 * generated from it via `@sourceweft/i18n/hant`'s `toTaiwanTraditional`
 * (OpenCC `twp` + the shared `packages/i18n/glossary/zh-TW.json`). Every entry
 * is exactly the generator's output — never hand-edited. The glossary cannot
 * rescue a bad rendering (its entries apply as sequential replacements, so e.g.
 * `新建→新增` still fires inside a longer word); reword the zh-CN source instead
 * so the generator yields acceptable Traditional. A unit test in
 * `auth-error-i18n.test.ts` asserts this table equals `toTaiwanTraditional`
 * applied to every zh-CN entry, so any drift fails CI.
 */
const ssoErrorMessagesZhTW: TranslationDictionary = {
  [SSO_ERROR_CODES.providerNotFound]: "該電子郵件未設定企業單一登入。",
  [SSO_ERROR_CODES.domainNotVerified]:
    "該網域尚未完成驗證，請聯絡管理員完成設定。",
  [SSO_ERROR_CODES.domainNotAllowed]: "該網域不能用於單一登入。",
  [SSO_ERROR_CODES.accountLinkDenied]:
    "無法將此登入關聯到已有帳號，請聯絡管理員。",
  [SSO_ERROR_CODES.seatLimit]: "團隊席位已滿，請聯絡管理員增加席位。",
  [SSO_ERROR_CODES.provisioningFailed]:
    "無法將你加入團隊，請重試或聯絡管理員。",
  [SSO_ERROR_CODES.invalidRoleAttribute]:
    "該角色屬性名不可用，請換一個屬性。",
  [SSO_ERROR_CODES.invalidAttributeMapping]:
    "該屬性對映使用了保留的欄位名，請換一個欄位名。",
  [SSO_ERROR_CODES.invalidProviderId]:
    "身分提供者 ID 需為 3–47 個小寫字母、數字或連字元，且不能與內建登入方式同名。",
  [SSO_ERROR_CODES.organizationRequired]: "單一登入只能為團隊設定。",
  [SSO_ERROR_CODES.providerLimit]: "該團隊的身分提供者數量已達上限（5 個）。",
  [SSO_ERROR_CODES.providerIdentityLocked]:
    "已有成員使用該身分提供者登入後，這些設定不能再修改。如需修改，請先刪除該身分提供者，再重新設定。",
  [SSO_ERROR_CODES.samlAlgorithmNotAllowed]:
    "身分提供者回傳的 SAML 回應使用了不支援的簽名設定。請聯絡管理員改用 SHA-256 簽名，並傳送未加密的斷言。",
};

// Traditional Chinese error messages. The official @better-auth/i18n plugin
// ships Simplified Chinese only (`locales.zh`, 34 error codes) and no
// Traditional pack, so this dictionary is generated from `locales.zh` with
// OpenCC (cn -> twp, Taiwan standard + phrases) plus the shared product-term
// glossary — the exact pipeline the web catalogs use
// (apps/web/scripts/i18n-hant.mjs, design §8 D7 / §16). Regenerate this table
// from `locales.zh` whenever the plugin's Simplified pack changes; do not
// hand-edit individual entries. The enterprise-SSO codes are spread in from
// `ssoErrorMessagesZhTW`, generated from `ssoErrorMessagesZhCN` the same way.
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
  ...ssoErrorMessagesZhTW,
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
  en: { ...locales.en, ...SSO_ERROR_MESSAGES_EN },
  zh: { ...locales.zh, ...ssoErrorMessagesZhCN },
  "zh-CN": { ...locales.zh, ...ssoErrorMessagesZhCN },
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

/**
 * Parses an `Accept-Language` header into base-language codes ordered by
 * quality (e.g. `"zh-TW,zh;q=0.9"` -> `["zh"]`, region/script subtags
 * dropped). A byte-for-byte copy of `@better-auth/i18n`'s own
 * `parseAcceptLanguage` (not exported by that package), kept identical on
 * purpose: {@link resolveGuardErrorLocale} below must resolve a bare
 * `Accept-Language` header exactly the way the plugin's own `detectLocale`
 * does, or the same request could get two different languages depending on
 * which code path throws.
 */
function parseAcceptLanguageBaseLocales(header: string | null): string[] {
  if (!header) {
    return [];
  }
  return header
    .split(",")
    .map((part) => {
      const [localeStr, quality = "q=1"] = part.trim().split(";");
      const q = Number.parseFloat(quality.replace("q=", ""));
      return { locale: localeStr?.trim().split("-")[0] ?? "", q };
    })
    .filter((item) => item.locale.length > 0)
    .sort((a, b) => b.q - a.q)
    .map((item) => item.locale);
}

/**
 * Resolves the locale an SSO guard (before-hook) error should be localized
 * in — using the exact same detection as the `@better-auth/i18n` plugin
 * applies to a handler-level error: the same sources, in the same order
 * ({@link AUTH_ERROR_LOCALE_DETECTION}), the same `Accept-Language`
 * base-language matching ({@link parseAcceptLanguageBaseLocales}, not a
 * normalizing negotiator), and the same English default.
 *
 * This exists because a before-hook's throw (every validation in
 * `guard-plugin.ts` / `policy.ts`) never reaches the `i18n` plugin's
 * after-hook at all (confirmed against better-auth@1.7.7's
 * `dispatchAuthEndpoint`: a before-hook rejection escapes it before any
 * after-hook runs), so those errors must localize themselves — and must
 * reproduce the plugin's own resolution rather than approximate it, or the
 * same request could see two different languages depending on which code
 * path happened to throw (e.g. `resolveMailLocale`'s negotiator folds
 * `Accept-Language: zh-TW` to `zh-TW`, while the plugin's own detection
 * folds it to the bare `zh` key, which this app's `zh` entry serves as
 * Simplified).
 */
export function resolveGuardErrorLocale(
  headers: Headers | null | undefined,
): keyof typeof authErrorTranslations {
  const availableLocales = Object.keys(authErrorTranslations);
  for (const strategy of AUTH_ERROR_LOCALE_DETECTION) {
    if (strategy === "callback") {
      const locale = resolveAuthErrorLocale({ headers } as GenericEndpointContext);
      if (locale && availableLocales.includes(locale)) {
        return locale as keyof typeof authErrorTranslations;
      }
    } else if (strategy === "cookie") {
      const cookieHeader = headers?.get("cookie");
      const cookieLocale = cookieHeader
        ? parseCookies(cookieHeader).get(AUTH_LOCALE_COOKIE)
        : undefined;
      if (cookieLocale && availableLocales.includes(cookieLocale)) {
        return cookieLocale as keyof typeof authErrorTranslations;
      }
    } else if (strategy === "header") {
      const matched = parseAcceptLanguageBaseLocales(
        headers?.get("Accept-Language") ?? null,
      ).find((locale) => availableLocales.includes(locale));
      if (matched) {
        return matched as keyof typeof authErrorTranslations;
      }
    }
  }
  return "en";
}
