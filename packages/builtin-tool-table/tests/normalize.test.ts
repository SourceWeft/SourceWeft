import assert from "node:assert/strict";
import test from "node:test";
import {
  dateCovered,
  extractFigures,
  normalizedValue,
  parseBoolean,
  parseDate,
  valueKey,
} from "../src/engine/normalize";

test("a figure reads the same in every common notation", () => {
  for (const written of ["1,200", "1200", "1.2k", "1.2K", "１２００", "１，２００", "一千二百", "1.2 thousand", "1.2千", "1200 participants"]) {
    assert.deepEqual(extractFigures(written), [1200], written);
  }
  assert.deepEqual(extractFigures("1.2万"), [12_000]);
  assert.deepEqual(extractFigures("3.5 million"), [3_500_000]);
  assert.deepEqual(extractFigures("4.1亿"), [410_000_000]);
  assert.deepEqual(extractFigures("约三万五千人"), [35_000]);
  assert.deepEqual(extractFigures("-5"), [-5]);
  assert.deepEqual(extractFigures("−5"), [-5]);
  assert.deepEqual(extractFigures("45.5%"), [45.5]);
});

test("text with no figure, or several, is not a single figure", () => {
  assert.deepEqual(extractFigures("none reported"), []);
  assert.deepEqual(extractFigures("12 to 15"), [12, 15]);
  assert.equal(normalizedValue("number", "12 to 15"), undefined);
  assert.equal(normalizedValue("number", "none"), undefined);
  assert.equal(normalizedValue("number", "1,200 participants"), 1200);
  assert.equal(normalizedValue("number", "一千二百"), 1200);
});

test("dates are read in the common notations and normalised to ISO at their own precision", () => {
  const cases: [string, string][] = [
    ["2024-03-05", "2024-03-05"],
    ["2024/3/5", "2024-03-05"],
    ["March 5, 2024", "2024-03-05"],
    ["5 March 2024", "2024-03-05"],
    ["5th of March, 2024", "2024-03-05"],
    ["Mar 5 2024", "2024-03-05"],
    ["2024年3月5日", "2024-03-05"],
    ["March 2024", "2024-03"],
    ["2024年3月", "2024-03"],
    ["2024-03", "2024-03"],
    ["2024", "2024"],
    ["2024年", "2024"],
    ["25/12/2023", "2023-12-25"],
  ];
  for (const [written, iso] of cases) {
    assert.equal(normalizedValue("date", written), iso, written);
  }
});

test("an ambiguous or unreadable date has no normalised value, and unreadable has no reading at all", () => {
  assert.equal(normalizedValue("date", "03/05/2024"), undefined);
  assert.notEqual(parseDate("03/05/2024"), undefined);
  assert.equal(parseDate("sometime last spring"), undefined);
  assert.equal(parseDate("2024-13-45"), undefined);
});

test("a date is covered when the passage states the same year, month and day, in any notation", () => {
  assert.equal(dateCovered("2024-03-05", "It was published on 5 March 2024."), true);
  assert.equal(dateCovered("March 5, 2024", "发布于 2024年3月5日。"), true);
  assert.equal(dateCovered("2024-03-05", "Published on March 6, 2024."), false);
  assert.equal(dateCovered("2024-03-05", "Published in March 2024."), false);
  assert.equal(dateCovered("March 2024", "Published on March 6, 2024."), true);
  assert.equal(dateCovered("2024", "In 2024 the study began."), true);
  assert.equal(dateCovered("2023", "In 2024 the study began."), false);
  assert.equal(dateCovered("03/05/2024", "Dated 5 March 2024."), true);
  assert.equal(dateCovered("2023–2024", "From 2023 to 2024."), true);
  assert.equal(dateCovered("2022-2024", "From 2023 to 2024."), false);
});

test("booleans read as yes or no in English and Chinese, and nothing else", () => {
  for (const yes of ["Yes", "yes.", "TRUE", "是", "是的", "有", "Yes, it is blinded"]) {
    assert.equal(parseBoolean(yes), true, yes);
  }
  for (const no of ["No", "false", "否", "不是", "没有", "无", "No, it is open label"]) {
    assert.equal(parseBoolean(no), false, no);
  }
  for (const unclear of ["maybe", "partly", "是否", "", "n/a"]) {
    assert.equal(parseBoolean(unclear), undefined, unclear);
  }
  assert.equal(normalizedValue("boolean", "是"), true);
  assert.equal(normalizedValue("text", "Yes"), undefined);
});

test("two values agree when they read the same for the column type", () => {
  assert.equal(valueKey("number", "1,200"), valueKey("number", "1.2k"));
  assert.notEqual(valueKey("number", "1,200"), valueKey("number", "1,300"));
  assert.equal(valueKey("date", "March 5, 2024"), valueKey("date", "2024-03-05"));
  assert.equal(valueKey("boolean", "Yes"), valueKey("boolean", "是"));
  assert.equal(valueKey("text", "Randomised  Trial."), valueKey("text", "randomised trial"));
  assert.notEqual(valueKey("text", "Randomised trial"), valueKey("text", "Cohort study"));
});
