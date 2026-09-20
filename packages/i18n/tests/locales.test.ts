import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LOCALE,
  getLocaleMeta,
  isLocale,
  LOCALE_IDS,
  LOCALES,
} from "../src/locales";

test("the first-phase locales are exactly en, zh-CN, zh-TW", () => {
  assert.deepEqual([...LOCALE_IDS], ["en", "zh-CN", "zh-TW"]);
});

test("the default locale is English", () => {
  assert.equal(DEFAULT_LOCALE, "en");
});

test("every id has a metadata row and the sets agree", () => {
  assert.equal(LOCALES.length, LOCALE_IDS.length);
  for (const id of LOCALE_IDS) {
    const meta = getLocaleMeta(id);
    assert.equal(meta.id, id);
    assert.ok(meta.nativeLabel.length > 0);
    assert.ok(meta.htmlLang.length > 0);
    assert.ok(meta.intlLocale.length > 0);
  }
});

test("all first-phase locales are LTR", () => {
  for (const meta of LOCALES) {
    assert.equal(meta.dir, "ltr");
  }
});

test("isLocale narrows only supported ids", () => {
  assert.equal(isLocale("en"), true);
  assert.equal(isLocale("zh-CN"), true);
  assert.equal(isLocale("zh-TW"), true);
  assert.equal(isLocale("zh-Hans"), false);
  assert.equal(isLocale("fr"), false);
  assert.equal(isLocale(undefined), false);
});

test("getLocaleMeta throws loudly on an unknown id", () => {
  assert.throws(() => getLocaleMeta("de" as never), /Unknown locale/);
});
