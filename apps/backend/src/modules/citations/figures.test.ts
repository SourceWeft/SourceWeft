import assert from "node:assert/strict";
import { test } from "vitest";
import { extractFigures, figuresCovered } from "./figures";

const sorted = (text: string) => extractFigures(text).sort((a, b) => a - b);
/** Figures compare with a tolerance, so floating-point noise is not a failure. */
function assertFigures(text: string, expected: number[]) {
  const actual = sorted(text);
  assert.equal(actual.length, expected.length, `${text}: ${actual}`);
  actual.forEach((value, index) => {
    const want = expected[index]!;
    assert.ok(
      Math.abs(value - want) <= 1e-6 * Math.max(1, want),
      `${text}: ${value} vs ${want}`,
    );
  });
}

test("digits, commas, decimals and percent signs read as values", () => {
  assert.deepEqual(
    sorted("Revenue grew 23% to 12,000 units, margin 18.5%"),
    [18.5, 23, 12000],
  );
});

test("a magnitude word or character multiplies the number before it", () => {
  assertFigures("$4.1 billion", [4.1e9]);
  assertFigures("41亿美元", [4.1e9]);
  assertFigures("$500 million", [5e8]);
  assertFigures("5亿", [5e8]);
  assertFigures("1.2万人", [12000]);
  assertFigures("10万公里", [100000]);
});

test("Chinese numerals are read, including units and percent phrases", () => {
  assertFigures("三天", [3]);
  assertFigures("七到九小时", [7, 9]);
  assertFigures("二十五人", [25]);
  assertFigures("三千二百", [3200]);
  assertFigures("五百万", [5e6]);
  assertFigures("十万", [1e5]);
  assertFigures("百分之六十", [60]);
});

test("English number words are read, compounds included", () => {
  assertFigures("three days", [3]);
  assertFigures("twenty-five people", [25]);
  assertFigures("seven to nine hours", [7, 9]);
  assertFigures("three hundred and five", [305]);
  assertFigures("two million", [2e6]);
});

test("a lone one, a lone magnitude word and plain words are not figures", () => {
  assert.deepEqual(extractFigures("one of the companies"), []);
  assert.deepEqual(extractFigures("一个国家"), []);
  assert.deepEqual(extractFigures("billions of dollars"), []);
  assert.deepEqual(extractFigures("The company grew."), []);
});

test("figures inside markup are read, tags are not", () => {
  assertFigures("<td>$49</td><td>25</td>", [25, 49]);
});

test("figures written differently across languages are covered", () => {
  assert.equal(
    figuresCovered(
      "2025财年营收增长23%，达到41亿美元",
      "Revenue grew 23% to $4.1 billion in fiscal 2025.",
    ),
    true,
  );
  assert.equal(
    figuresCovered(
      "董事会批准了价值5亿美元的回购计划",
      "The board approved a buyback programme worth $500 million.",
    ),
    true,
  );
  assert.equal(
    figuresCovered(
      "每周最多可以远程办公三天",
      "Remote work is permitted for up to three days per week.",
    ),
    true,
  );
  assert.equal(
    figuresCovered("Headcount remained at 12,000", "员工人数保持在12000人。"),
    true,
  );
  assert.equal(
    figuresCovered(
      "Adults are advised to sleep seven to nine hours",
      "成年人每晚建议睡眠七到九小时。",
    ),
    true,
  );
});

test("a figure the passage does not state is not covered", () => {
  assert.equal(
    figuresCovered(
      "Adults should sleep five hours per night",
      "成年人每晚建议睡眠七到九小时。",
    ),
    false,
  );
  assert.equal(
    figuresCovered(
      "员工人数翻倍至24000人",
      "Headcount stayed flat at 12,000 employees.",
    ),
    false,
  );
  assert.equal(
    figuresCovered(
      "年假最多可以结转十五天",
      "Employees may carry over up to five unused vacation days.",
    ),
    false,
  );
});

test("a claim without figures is covered, and a month name answers a month number", () => {
  assert.equal(
    figuresCovered(
      "公司扩大了云业务",
      "The company expanded its cloud business.",
    ),
    true,
  );
  assert.equal(
    figuresCovered("卫星于3月发射", "The satellite was launched in March."),
    true,
  );
  assert.equal(
    figuresCovered("The launch may slip", "No dates were given."),
    true,
  );
});

test("an ordinal and a unit word are not figures", () => {
  assertFigures("第二季度净销售额增长14%", [14]);
  assertFigures("电池容量由60千瓦时提升至82千瓦时", [60, 82]);
  assertFigures("第三次", []);
  assertFigures("万一出现问题", []);
  assertFigures("十万公里", [1e5]);
});

test("a quarter and a kilowatt-hour do not stop a claim from being covered", () => {
  assert.equal(
    figuresCovered(
      "第二季度净销售额同比增长14%，达到78亿美元",
      "Net sales rose 14% to $7.8 billion in the second quarter.",
    ),
    true,
  );
  assert.equal(
    figuresCovered(
      "电池容量由60千瓦时提升至82千瓦时",
      "Battery capacity increased from 60 kWh to 82 kWh.",
    ),
    true,
  );
});

test("a k suffix multiplies the number it touches by a thousand", () => {
  assertFigures("1.2k participants", [1200]);
  assertFigures("about 5K users", [5000]);
  assertFigures("2.5k to 3k", [2500, 3000]);
});

test("a k that starts a word or a unit is not a suffix", () => {
  assertFigures("3 key points", [3]);
  assertFigures("a 10km run", [10]);
  assertFigures("60 kWh", [60]);
  assertFigures("5 kg of rice", [5]);
  // The k must touch the number: a spaced letter is part of the next word.
  assertFigures("12 k", [12]);
});

test("1.2k and 1,200 cover each other, and a different figure does not", () => {
  assert.equal(figuresCovered("1.2k participants", "Enrolled 1,200 participants."), true);
  assert.equal(figuresCovered("1,200 participants", "Enrolled 1.2k participants."), true);
  assert.equal(figuresCovered("1,300", "1.2k participants"), false);
  assert.equal(figuresCovered("1.2k", "enrolled 12,000"), false);
});

test("a table value with a bracketed unit is covered by the bare figure its source states", () => {
  // The table engine hands the port width-normalised text (NFKC).
  for (const value of [
    "423,701,834（千元）",
    "423,701,834（千元）".normalize("NFKC"),
    "1,050,506百万元",
    "1,050,506（百万元）".normalize("NFKC"),
  ]) {
    assert.equal(
      figuresCovered(value, "营业收入 | 423,701,834 | 1,050,506"),
      true,
      value,
    );
  }
  assert.equal(
    figuresCovered("432,701,834(千元)", "营业收入 | 423,701,834"),
    false,
  );
});
