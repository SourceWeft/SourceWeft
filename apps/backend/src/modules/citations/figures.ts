/**
 * The numbers a sentence states, as values, whatever language and notation
 * they are written in: `4.1 billion`, `41亿`, `4,100 million` and
 * `four point one billion` all read as 4.1e9; `三天` and `three days` as 3.
 *
 * Used to check that a passage found by meaning really states the figures the
 * claim states. Meaning-based matching cannot see that "slept five hours" is
 * not "sleep seven to nine hours", and figures written differently across
 * languages defeat a plain digit comparison.
 */

const EN_UNITS = new Map<string, number>(
  Object.entries({
    zero: 0,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
  }),
);
const EN_MAGNITUDES = new Map<string, number>([
  ["hundred", 100],
  ["thousand", 1e3],
  ["million", 1e6],
  ["billion", 1e9],
  ["trillion", 1e12],
]);
const MONTHS = new Map<string, number>(
  [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].map((name, index) => [name, index + 1]),
);
const CJK_DIGITS = new Map<string, number>(
  Object.entries({
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  }),
);
const CJK_SMALL_UNITS = new Map<string, number>([
  ["十", 10],
  ["百", 100],
  ["千", 1000],
]);
const CJK_BIG_UNITS = new Map<string, number>([
  ["万", 1e4],
  ["亿", 1e8],
]);
const CJK_NUMERAL = /[零〇一二两三四五六七八九十百千万亿]+/g;
const DIGIT_MAGNITUDES = new Map<string, number>([
  ["billion", 1e9],
  ["million", 1e6],
  ["thousand", 1e3],
  ["trillion", 1e12],
  ["亿", 1e8],
  ["万", 1e4],
]);
// `k` counts only when it touches the number and ends the word: "1.2k" is
// 1,200, while "10km", "5 kg" and "3 key points" keep their plain figure.
const DIGIT_NUMBER =
  /(\d[\d,]*(?:\.\d+)?)(?:\s*(billion|million|thousand|trillion|亿|万)|(k)(?![a-z]))?/gi;

function parseCjkNumeral(value: string) {
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const char of value) {
    const d = CJK_DIGITS.get(char);
    const small = CJK_SMALL_UNITS.get(char);
    const big = CJK_BIG_UNITS.get(char);
    if (d !== undefined) {
      digit = d;
    } else if (small !== undefined) {
      section += (digit || 1) * small;
      digit = 0;
    } else if (big !== undefined) {
      total += (section + digit || 1) * big;
      section = 0;
      digit = 0;
    }
  }
  return total + section + digit;
}

function parseEnglishRun(words: string[]) {
  let total = 0;
  let current = 0;
  let sawUnit = false;
  for (const word of words) {
    const unit = EN_UNITS.get(word);
    const magnitude = EN_MAGNITUDES.get(word);
    if (unit !== undefined) {
      current += unit;
      sawUnit = true;
    } else if (magnitude !== undefined) {
      if (magnitude === 100) current = (current || 1) * 100;
      else {
        total += (current || 1) * magnitude;
        current = 0;
      }
    }
  }
  return sawUnit ? total + current : null;
}

export function extractFigures(
  raw: string,
  options: { months?: boolean } = {},
): number[] {
  let text = raw.replace(/<[^>]+>/g, " ").toLowerCase();
  const values: number[] = [];

  text = text.replace(
    DIGIT_NUMBER,
    (_match, digits: string, magnitude?: string, kilo?: string) => {
      const value = Number.parseFloat(digits.replace(/,/g, ""));
      if (Number.isFinite(value)) {
        values.push(
          value *
            (magnitude ? (DIGIT_MAGNITUDES.get(magnitude) ?? 1) : kilo ? 1e3 : 1),
        );
      }
      return " ";
    },
  );

  // 百分之六十 is "60%", not a hundred and sixty.
  text = text.replace(
    /百分之([零〇一二两三四五六七八九十百千]+)/g,
    (_m, num: string) => {
      values.push(parseCjkNumeral(num));
      return " ";
    },
  );
  // 第二季度 is "the second quarter": an ordinal is a position, not a quantity.
  text = text.replace(/第[零〇一二两三四五六七八九十百千]+/g, " ");
  text = text.replace(CJK_NUMERAL, (run) => {
    // Units alone are words, not numbers: 千瓦时 is "kilowatt-hour", not 1000.
    // A run is a number when it starts with a digit character or 十 (万一, "in case", does not).
    if (!/^[零〇一二两三四五六七八九十]/.test(run)) {
      return " ";
    }
    const value = parseCjkNumeral(run);
    // A lone 一 is "a", not a figure, and 零 on its own carries nothing.
    if (value > 1) values.push(value);
    return " ";
  });

  const words = text.match(/[a-z]+/g) ?? [];
  let run: string[] = [];
  const flush = () => {
    const value = run.length ? parseEnglishRun(run) : null;
    if (value !== null && value > 1) values.push(value);
    run = [];
  };
  for (const word of words) {
    if (
      EN_UNITS.has(word) ||
      EN_MAGNITUDES.has(word) ||
      (word === "and" && run.length)
    ) {
      run.push(word);
    } else {
      flush();
      if (options.months && MONTHS.has(word)) values.push(MONTHS.get(word)!);
    }
  }
  flush();
  return values;
}

function same(a: number, b: number) {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Every figure the claim states appears in the passage. A claim with no
 * figures is covered by any passage. Month names count only on the passage
 * side, so "March" there can answer "3月" in the claim without a modal "may"
 * ever becoming a figure the claim must prove.
 */
export function figuresCovered(claim: string, passage: string) {
  const wanted = extractFigures(claim);
  if (wanted.length === 0) return true;
  const available = extractFigures(passage, { months: true });
  return wanted.every((figure) =>
    available.some((value) => same(value, figure)),
  );
}
