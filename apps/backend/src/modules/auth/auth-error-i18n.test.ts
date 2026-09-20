import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  AUTH_ERROR_LOCALE_DETECTION,
  AUTH_LOCALE_COOKIE,
  AUTH_LOCALE_HEADER,
  authErrorTranslations,
  resolveAuthErrorLocale,
} from "./auth-error-i18n";

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
});
