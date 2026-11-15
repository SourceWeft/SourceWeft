import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  SSO_ERROR_CODES,
  SSO_ERROR_MESSAGES_EN,
  ssoError,
} from "../enterprise-sso/errors";
import {
  AUTH_ERROR_LOCALE_DETECTION,
  AUTH_LOCALE_COOKIE,
  AUTH_LOCALE_HEADER,
  authErrorTranslations,
  resolveAuthErrorLocale,
} from "./auth-error-i18n";

const SSO_MESSAGES_ZH_CN: Record<string, string> = {
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
  [SSO_ERROR_CODES.invalidProviderId]:
    "身份源 ID 需为 3–47 个小写字母、数字或连字符。",
  [SSO_ERROR_CODES.organizationRequired]: "单点登录只能为团队配置。",
  [SSO_ERROR_CODES.providerLimit]: "该团队的身份源数量已达上限（5 个）。",
  [SSO_ERROR_CODES.providerIdentityLocked]:
    "已有成员通过该身份源登录后，这些设置不能再修改。如需修改，请删除该身份源后重新添加。",
  [SSO_ERROR_CODES.samlAlgorithmNotAllowed]:
    "身份源返回的 SAML 响应使用了不支持的签名设置。请联系管理员改用 SHA-256 签名，并发送未加密的断言。",
};

/**
 * Reviewed Taiwan Traditional renderings (see auth-error-i18n.ts's
 * `ssoErrorMessagesZhTW`). Asserted verbatim so a future hand-edit or a
 * regeneration that silently reverts the glossary fixes is caught.
 */
const SSO_MESSAGES_ZH_TW: Record<string, string> = {
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
  [SSO_ERROR_CODES.invalidProviderId]:
    "身分提供者 ID 需為 3–47 個小寫字母、數字或連字元。",
  [SSO_ERROR_CODES.organizationRequired]: "單一登入只能為團隊設定。",
  [SSO_ERROR_CODES.providerLimit]: "該團隊的身分提供者數量已達上限（5 個）。",
  [SSO_ERROR_CODES.providerIdentityLocked]:
    "已有成員通過該身分提供者登入後，這些設定不能再修改。如需修改，請刪除該身分提供者後重新新增。",
  [SSO_ERROR_CODES.samlAlgorithmNotAllowed]:
    "身分提供者返回的 SAML 回應使用了不支援的簽名設定。請聯絡管理員改用 SHA-256 簽名，並傳送未加密的斷言。",
};

/**
 * Every character in the zh-CN table strings above that OpenCC (`cn2t`/`twp`)
 * converts to a different Traditional form. None of these may appear in the
 * zh-TW table: each is either rewritten (`该`→`該`, `点`→`點`, …) or replaced
 * entirely as part of a glossary phrase (`单点登录`→`單一登入`, `身份源`→
 * `身分提供者`, neither of which contains most of these characters anyway).
 */
const SIMPLIFIED_ONLY_CHARS = [
  ..."该邮箱配置业单点录验证请联系员于无将关账号团队满试属换个份源为写数连符达过后这设删添响应持签并发断",
];

describe("auth error i18n", () => {
  test("registers every app locale plus a base `zh` for Accept-Language", () => {
    assert.deepEqual(Object.keys(authErrorTranslations).sort(), [
      "en",
      "zh",
      "zh-CN",
      "zh-TW",
    ]);
  });

  test("zh-CN serves Simplified and zh-TW serves Traditional", () => {
    assert.equal(
      authErrorTranslations["zh-CN"].INVALID_EMAIL_OR_PASSWORD,
      "邮箱或密码无效",
    );
    assert.equal(
      authErrorTranslations["zh-TW"].INVALID_EMAIL_OR_PASSWORD,
      "郵箱或密碼無效",
    );
    // The base `zh` fallback is Simplified, matching the shipped plugin pack.
    assert.equal(
      authErrorTranslations.zh.INVALID_EMAIL_OR_PASSWORD,
      "邮箱或密码无效",
    );
  });

  test("Traditional dictionary covers the full Simplified code set", () => {
    assert.deepEqual(
      Object.keys(authErrorTranslations["zh-TW"]).sort(),
      Object.keys(authErrorTranslations.zh).sort(),
    );
  });

  test("detects locale by explicit header, then cookie, then Accept-Language", () => {
    assert.deepEqual(
      [...AUTH_ERROR_LOCALE_DETECTION],
      ["callback", "cookie", "header"],
    );
    assert.equal(AUTH_LOCALE_COOKIE, "sw_locale");
  });

  test("resolveAuthErrorLocale reads the x-sw-locale header and validates it", () => {
    const read = (value: string | null) =>
      resolveAuthErrorLocale({
        headers: value
          ? new Headers({ [AUTH_LOCALE_HEADER]: value })
          : new Headers(),
        // Only ctx.headers is read; the rest of the endpoint context is unused.
      } as never);
    assert.equal(read("zh-TW"), "zh-TW");
    assert.equal(read("zh-CN"), "zh-CN");
    assert.equal(read("fr"), null);
    assert.equal(read(null), null);
  });

  test("every app locale carries all twelve enterprise-SSO codes", () => {
    const ssoCodes = Object.values(SSO_ERROR_CODES);
    for (const locale of ["en", "zh", "zh-CN", "zh-TW"] as const) {
      for (const code of ssoCodes) {
        assert.ok(
          authErrorTranslations[locale][code],
          `expected ${locale} to carry a message for ${code}`,
        );
      }
    }
  });

  test("en and zh-CN SSO messages match the task-7 table verbatim", () => {
    for (const code of Object.values(SSO_ERROR_CODES)) {
      assert.equal(authErrorTranslations.en[code], SSO_ERROR_MESSAGES_EN[code]);
      assert.equal(
        authErrorTranslations["zh-CN"][code],
        SSO_MESSAGES_ZH_CN[code],
      );
    }
  });

  test("ssoError's message (errors.ts's single English source) matches authErrorTranslations.en for every code", () => {
    for (const code of Object.values(SSO_ERROR_CODES)) {
      const error = ssoError(code, "BAD_REQUEST");
      assert.equal(error.body?.code, code);
      assert.equal(error.message, authErrorTranslations.en[code]);
    }
  });

  test("zh-TW SSO messages are the reviewed Taiwan Traditional renderings", () => {
    for (const code of Object.values(SSO_ERROR_CODES)) {
      assert.equal(authErrorTranslations["zh-TW"][code], SSO_MESSAGES_ZH_TW[code]);
    }
  });

  test("zh-TW SSO messages contain no Simplified-only characters from zh-CN", () => {
    for (const code of Object.values(SSO_ERROR_CODES)) {
      const zhTW = authErrorTranslations["zh-TW"][code];
      assert.ok(zhTW, `expected a zh-TW message for ${code}`);
      for (const char of SIMPLIFIED_ONLY_CHARS) {
        assert.ok(
          !zhTW.includes(char),
          `expected zh-TW ${code} ("${zhTW}") not to contain "${char}"`,
        );
      }
    }
  });
});
