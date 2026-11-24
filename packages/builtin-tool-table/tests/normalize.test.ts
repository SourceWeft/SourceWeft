import assert from "node:assert/strict";
import test from "node:test";
import {
  coverDate,
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

test("a date the passage states as written is kept as written", () => {
  assert.equal(coverDate("2025-12-31", "As of December 31, 2025, revenue rose."), "2025-12-31");
  assert.equal(coverDate("December 31, 2025", "截至2025年12月31日"), "December 31, 2025");
  assert.equal(coverDate("2025", "截至2025年末"), "2025");
});

test("a date more precise than its passage is kept at the precision the passage states", () => {
  assert.equal(coverDate("2025-12-31", "截至2025年末"), "2025");
  assert.equal(coverDate("2025-12-31", "2025年年度报告"), "2025");
  assert.equal(coverDate("2025-12-31", "2025年12月"), "2025-12");
  assert.equal(coverDate("2025-12-31", "截至2025年12月"), "2025-12");
  assert.equal(coverDate("2025-12", "2025年年度报告"), "2025");
  assert.equal(coverDate("December 2025", "In fiscal 2025 the company grew."), "2025");
  // The most precise agreeing reading wins, wherever it stands in the passage.
  assert.equal(coverDate("2025-12-31", "截至2025年12月，2025年年度报告"), "2025-12");
  assert.equal(coverDate("2025-12-31", "2025年年度报告（截至2025年12月）"), "2025-12");
  // A reading that disagrees on the month does not count, an agreeing one does.
  assert.equal(coverDate("2025-12-31", "2025年11月发布的2025年年度报告"), "2025");
});

test("a date is never accepted with a year or month its passage contradicts, or from a month without a year", () => {
  assert.equal(coverDate("2024-12-31", "截至2025年末"), undefined);
  assert.equal(coverDate("2025-11-30", "截至2025年12月"), undefined);
  assert.equal(coverDate("2026-06-30", "6月末"), undefined);
  assert.equal(coverDate("2026-06-30", "截至6月末，余额为12亿元"), undefined);
  assert.equal(coverDate("sometime in 2025", "no date here"), undefined);
  assert.equal(coverDate("not a date", "截至2025年末"), undefined);
});

test("a value with several dates or several readings is never moved to another precision", () => {
  assert.equal(coverDate("2025-06-30 to 2025-12-31", "2025年年度报告"), undefined);
  assert.equal(coverDate("03/05/2025", "2025年年度报告"), undefined);
  // Covered as written, a value with two dates is still kept as it is.
  assert.equal(coverDate("2023–2024", "From 2023 to 2024."), "2023–2024");
});

test("bracketed units and multi-character Chinese magnitudes scale the figure they follow", () => {
  const cases: [string, number][] = [
    ["423,701,834（千元）", 423_701_834_000],
    ["423,701,834 (千元)", 423_701_834_000],
    ["1,050,506（百万元）", 1_050_506_000_000],
    ["1,050,506百万元", 1_050_506_000_000],
    ["1,050,506 百万元", 1_050_506_000_000],
    ["1,050,506 (in millions)", 1_050_506_000_000],
    ["4.2 (millions)", 4_200_000],
    ["4.2 (In Millions)", 4_200_000],
    ["7,500 (in thousands)", 7_500_000],
    ["12,345（单位：千元）", 12_345_000],
    ["8,000（人民币百万元）", 8_000_000_000],
    ["3千万", 30_000_000],
    ["3.5千万元", 35_000_000],
    ["2.5万亿元", 2_500_000_000_000],
    ["12百亿", 120_000_000_000],
  ];
  for (const [written, value] of cases) {
    assert.deepEqual(extractFigures(written), [value], written);
  }
  assert.equal(normalizedValue("number", "423,701,834（千元）"), 423_701_834_000);
  assert.equal(valueKey("number", "1,050,506百万元"), valueKey("number", "1,050,506（百万元）"));
  assert.notEqual(valueKey("number", "1,050,506百万元"), valueKey("number", "1,050,506百元"));
});

test("a bracketed unit applies only to the figure it directly follows", () => {
  assert.deepEqual(extractFigures("100 and 200（千元）"), [100, 200_000]);
  assert.deepEqual(extractFigures("营业收入（千元） 423,701,834"), [423_701_834]);
  assert.deepEqual(extractFigures("（单位：千元）300"), [300]);
  assert.deepEqual(extractFigures("1,200 (2023)"), [1200, 2023]);
  assert.deepEqual(extractFigures("1,200 (see note)"), [1200]);
});

test("the existing number notations keep their readings", () => {
  const cases: [string, number[]][] = [
    ["1.2k", [1200]],
    ["12亿", [1_200_000_000]],
    ["4.1 billion", [4_100_000_000]],
    ["3,571亿元", [357_100_000_000]],
    ["50%", [50]],
    ["1,200", [1200]],
    ["1200", [1200]],
    ["5百", [500]],
    ["1.2千", [1200]],
    ["1.2万", [12_000]],
    ["12万千瓦", [120_000]],
    ["一千二百", [1200]],
    ["约三万五千人", [35_000]],
    ["12 to 15", [12, 15]],
  ];
  for (const [written, values] of cases) {
    assert.deepEqual(extractFigures(written), values, written);
  }
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
