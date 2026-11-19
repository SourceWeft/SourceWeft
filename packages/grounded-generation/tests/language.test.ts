import assert from "node:assert/strict";
import test from "node:test";
import { matchesOutputLanguage, resolveOutputLanguage } from "../src/language";

test("matchesOutputLanguage checks the script of Chinese and English output", () => {
  assert.equal(matchesOutputLanguage("光合作用把光能转化为化学能 (photosynthesis)", "zh-CN"), true);
  assert.equal(matchesOutputLanguage("Photosynthesis converts light into energy", "zh-CN"), false);
  assert.equal(matchesOutputLanguage("Photosynthesis converts light", "en"), true);
  assert.equal(matchesOutputLanguage("光合作用把光能转化为化学能", "en-US"), false);
  // Languages without a script rule are not judged.
  assert.equal(matchesOutputLanguage("anything", "fr"), true);
  // Text without letters (a formula) is not judged either.
  assert.equal(matchesOutputLanguage("3 = 1 + 2", "zh"), true);
});

test("resolveOutputLanguage prefers the request, then a source majority, then the UI", () => {
  const chunks = (langs: [string | null, number][]) =>
    langs.map(([language, tokens]) => ({ language, tokens }));
  assert.equal(
    resolveOutputLanguage({ requested: " fr ", chunks: chunks([["en", 10]]), uiLocale: "zh-CN" }),
    "fr",
  );
  assert.equal(
    resolveOutputLanguage({ chunks: chunks([["zh", 60], ["en", 40]]), uiLocale: "en" }),
    "zh",
  );
  assert.equal(
    resolveOutputLanguage({ chunks: chunks([["zh", 59], ["en", 41]]), uiLocale: "en" }),
    "en",
  );
  assert.equal(
    resolveOutputLanguage({ chunks: chunks([["zh", 50], ["en", 50]]), uiLocale: "zh-TW" }),
    "zh-TW",
  );
  assert.equal(resolveOutputLanguage({ chunks: chunks([[null, 10]]), uiLocale: "en" }), "en");
  assert.equal(resolveOutputLanguage({ chunks: [], uiLocale: "en" }), "en");
});
