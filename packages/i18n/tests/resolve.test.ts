import assert from "node:assert/strict";
import test from "node:test";

import {
  addLocalePrefix,
  negotiateLocale,
  normalizeToLocale,
  parseAcceptLanguage,
  stripLocalePrefix,
} from "../src/resolve";

test("normalizeToLocale folds the Simplified family to zh-CN", () => {
  for (const tag of ["zh", "zh-CN", "zh-Hans", "zh-Hans-CN", "zh-SG", "ZH-hans"]) {
    assert.equal(normalizeToLocale(tag), "zh-CN", tag);
  }
});

test("normalizeToLocale folds the Traditional family to zh-TW", () => {
  for (const tag of ["zh-TW", "zh-Hant", "zh-Hant-TW", "zh-HK", "zh-MO", "ZH-hant-hk"]) {
    assert.equal(normalizeToLocale(tag), "zh-TW", tag);
  }
});

test("normalizeToLocale maps any English region to en and rejects the unknown", () => {
  assert.equal(normalizeToLocale("en"), "en");
  assert.equal(normalizeToLocale("en-GB"), "en");
  assert.equal(normalizeToLocale("fr-FR"), null);
  assert.equal(normalizeToLocale(""), null);
  assert.equal(normalizeToLocale(undefined), null);
});

test("parseAcceptLanguage honours q-weights and skips unsupported tags", () => {
  assert.equal(parseAcceptLanguage("fr-FR,fr;q=0.9,zh-TW;q=0.8"), "zh-TW");
  assert.equal(parseAcceptLanguage("en-US,en;q=0.9"), "en");
  assert.equal(parseAcceptLanguage("de,ja;q=0.5"), null);
  assert.equal(parseAcceptLanguage(null), null);
});

test("negotiateLocale takes the first resolvable candidate, else the default", () => {
  // §5 priority: URL prefix beats cookie beats Accept-Language.
  assert.equal(negotiateLocale(["zh-CN", "zh-TW", "en"]), "zh-CN");
  assert.equal(negotiateLocale([null, "zh-TW", "en"]), "zh-TW");
  assert.equal(negotiateLocale([undefined, null, "de"]), "en");
  assert.equal(negotiateLocale([]), "en");
});

test("stripLocalePrefix splits a marketing locale segment off the path", () => {
  assert.deepEqual(stripLocalePrefix("/zh-CN/about"), {
    locale: "zh-CN",
    pathname: "/about",
  });
  assert.deepEqual(stripLocalePrefix("/zh-TW"), {
    locale: "zh-TW",
    pathname: "/",
  });
  assert.deepEqual(stripLocalePrefix("/about"), {
    locale: null,
    pathname: "/about",
  });
  assert.deepEqual(stripLocalePrefix("/dashboard/chat"), {
    locale: null,
    pathname: "/dashboard/chat",
  });
});

test("addLocalePrefix is as-needed: default carries no prefix, others do", () => {
  // Mirrors the §4.2 URL table.
  assert.equal(addLocalePrefix("/about", "en"), "/about");
  assert.equal(addLocalePrefix("/about", "zh-CN"), "/zh-CN/about");
  assert.equal(addLocalePrefix("/", "zh-TW"), "/zh-TW");
  // Replacing an existing prefix rather than stacking it.
  assert.equal(addLocalePrefix("/zh-CN/about", "zh-TW"), "/zh-TW/about");
  assert.equal(addLocalePrefix("/zh-CN/about", "en"), "/about");
});
