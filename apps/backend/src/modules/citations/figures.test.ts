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
