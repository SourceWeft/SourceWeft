import assert from "node:assert/strict";
import test from "node:test";
import { matchesOutputLanguage } from "../src/language";

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
