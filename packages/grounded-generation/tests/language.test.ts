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

test("with Latin words as units, kept English names do not fail Chinese output", () => {
  // A Chinese answer that keeps product names, as the table prompt asks:
  // 15 Han letters against 46 Latin letters, but only 8 Latin words.
  const kept =
    "高可用、分支、自动扩缩容与缩容到零、Managed Better Auth、Data API、Object Storage 与 Functions";
  assert.equal(matchesOutputLanguage(kept, "zh-CN"), false);
  assert.equal(matchesOutputLanguage(kept, "zh-CN", { latinWordUnits: true }), true);
  // An answer left in English still fails, however it is counted.
  assert.equal(
    matchesOutputLanguage("1 GB per project; branching and autoscaling", "zh-CN", {
      latinWordUnits: true,
    }),
    false,
  );
  // Words, not letters: 2 Han letters against 6 Latin words is under 30%.
  assert.equal(
    matchesOutputLanguage("Build in a weekend, scale fast 口号", "zh", { latinWordUnits: true }),
    false,
  );
  // A hyphen or a digit ends a word: "Llama-3.1-70B" is two words ("Llama", "B").
  assert.equal(
    matchesOutputLanguage("最大的模型是 Llama-3.1-70B", "zh", { latinWordUnits: true }),
    true,
  );
  // English output is still judged by letters.
  assert.equal(
    matchesOutputLanguage("Tsinghua 清华大学 study", "en", { latinWordUnits: true }),
    matchesOutputLanguage("Tsinghua 清华大学 study", "en"),
  );
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
