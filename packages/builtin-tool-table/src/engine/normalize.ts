import { normalizeFingerprintText } from "@sourceweft/contracts/grounded-generation";
import type { TableColumnType } from "@sourceweft/contracts/table";

/**
 * Reading cell values for comparison and for sorting. Nothing here decides
 * whether a value is supported by its source; it only turns a written value
 * into a number, an ISO date or a boolean so two notations of the same thing
 * can be told apart from two different things.
 */

/* ----------------------------------------------------------------- figures */

const CJK_DIGITS = new Map<string, number>(
  Object.entries({
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  }),
);
const CJK_SMALL_UNITS = new Map<string, number>([["十", 10], ["百", 100], ["千", 1000]]);
const CJK_BIG_UNITS = new Map<string, number>([["万", 1e4], ["亿", 1e8]]);
const MAGNITUDES = new Map<string, number>([
  ["k", 1e3],
  ["thousand", 1e3],
  ["million", 1e6],
  ["billion", 1e9],
  ["trillion", 1e12],
  ["千", 1e3],
  ["百", 1e2],
  ["万", 1e4],
  ["亿", 1e8],
  ["十万", 1e5],
  ["百万", 1e6],
  ["千万", 1e7],
  ["十亿", 1e9],
  ["百亿", 1e10],
  ["千亿", 1e11],
  ["万亿", 1e12],
]);
/** A Chinese magnitude, the compounds first so 百万 is not read as 百. */
const CJK_MAGNITUDE = "十万|百万|千万|十亿|百亿|千亿|万亿|[千百万亿]";
const EN_MAGNITUDE = "thousand|million|billion|trillion";
/**
 * A unit in brackets right after a figure, as financial tables write it:
 * `(千元)`, `(百万元)`, `(单位:千元)`, `(人民币百万元)`, `(in millions)`,
 * `(millions)`. Text is NFKC-normalised first, so full-width brackets and
 * colons match too. Only a bracket that holds nothing but a unit counts.
 */
const BRACKETED_UNIT =
  `\\s*\\(\\s*(?:` +
  `(?:in\\s+)?(?:(?:us\\$|\\$|usd|rmb|cny|eur|€|£)\\s*)?(${EN_MAGNITUDE})s?(?:\\s+of\\s+[a-z$]+)?` +
  `|(?:单位\\s*:\\s*)?(?:人民币|美元|港元|港币)?\\s*(${CJK_MAGNITUDE})\\s*(?:元|美元|港元|港币|人民币|欧元|日元|英镑|股)?` +
  `)\\s*\\)`;
/**
 * Digits (with thousands separators) and an optional magnitude: a word, a `k`
 * suffix, a Chinese magnitude, or a bracketed unit that directly follows.
 */
const ARABIC_NUMBER = new RegExp(
  `(?<![\\d.])(-?)(\\d{1,3}(?:,\\d{3})+|\\d+)(\\.\\d+)?` +
    `(?:\\s*(${EN_MAGNITUDE})(?![a-z])|(k)(?![a-z])|\\s*(${CJK_MAGNITUDE})|${BRACKETED_UNIT})?`,
  "gi",
);
const CJK_NUMERAL = /[零〇一二两三四五六七八九十百千万亿]+/g;

function parseCjkNumeral(run: string): number {
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const char of run) {
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

/** Every figure a value states, in order, whatever notation it is written in. */
export function extractFigures(raw: string): number[] {
  let text = raw.normalize("NFKC").replaceAll("−", "-");
  const found: { at: number; value: number }[] = [];
  text = text.replace(
    ARABIC_NUMBER,
    (
      match: string,
      sign: string,
      whole: string,
      fraction: string | undefined,
      word: string | undefined,
      k: string | undefined,
      cjk: string | undefined,
      bracketedWord: string | undefined,
      bracketedCjk: string | undefined,
      at: number,
    ) => {
      const base = Number.parseFloat(`${whole.replaceAll(",", "")}${fraction ?? ""}`);
      const unit = word ?? k ?? cjk ?? bracketedWord ?? bracketedCjk ?? "";
      const magnitude = MAGNITUDES.get(unit.toLowerCase()) ?? 1;
      found.push({ at, value: Number(((sign ? -1 : 1) * base * magnitude).toPrecision(12)) });
      return " ".repeat(match.length);
    },
  );
  text.replace(CJK_NUMERAL, (run, at: number) => {
    // A run is a number when it starts with a digit character or 十 (万一, "in
    // case", does not); units alone (千瓦时) are words.
    if (/^[零〇一二两三四五六七八九十]/.test(run)) {
      found.push({ at, value: parseCjkNumeral(run) });
    }
    return run;
  });
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.value);
}

/* ------------------------------------------------------------------- dates */

type Ymd = { y: number; m?: number; d?: number };

const MONTH = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const MONTH_NUMBER = new Map(
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].map(
    (name, index) => [name, index + 1],
  ),
);
const monthOf = (name: string) => MONTH_NUMBER.get(name.slice(0, 3).toLowerCase())!;

const validMonth = (m: number) => m >= 1 && m <= 12;
const validDay = (d: number) => d >= 1 && d <= 31;

type DatePattern = { pattern: RegExp; read: (match: RegExpExecArray) => Ymd[] };

const DATE_PATTERNS: DatePattern[] = [
  {
    pattern: /(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g,
    read: ([, y, m, d]) =>
      validMonth(+m!) && validDay(+d!) ? [{ y: +y!, m: +m!, d: +d! }] : [],
  },
  {
    pattern: /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/g,
    read: ([, y, m, d]) =>
      validMonth(+m!) && validDay(+d!) ? [{ y: +y!, m: +m!, d: +d! }] : [],
  },
  {
    pattern: /(\d{4})\s*年\s*(\d{1,2})\s*月/g,
    read: ([, y, m]) => (validMonth(+m!) ? [{ y: +y!, m: +m! }] : []),
  },
  {
    pattern: new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"),
    read: ([, month, d, y]) => (validDay(+d!) ? [{ y: +y!, m: monthOf(month!), d: +d! }] : []),
  },
  {
    pattern: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})\\.?,?\\s+(\\d{4})\\b`, "gi"),
    read: ([, d, month, y]) => (validDay(+d!) ? [{ y: +y!, m: monthOf(month!), d: +d! }] : []),
  },
  {
    pattern: new RegExp(`\\b(${MONTH})\\.?,?\\s+(\\d{4})\\b`, "gi"),
    read: ([, month, y]) => [{ y: +y!, m: monthOf(month!) }],
  },
  {
    // 03/05/2024 reads as day-first or month-first; both readings are kept.
    pattern: /(?<!\d)(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)/g,
    read: ([, a, b, y]) => {
      const readings: Ymd[] = [];
      if (validMonth(+a!) && validDay(+b!)) readings.push({ y: +y!, m: +a!, d: +b! });
      if (validMonth(+b!) && validDay(+a!) && a !== b) readings.push({ y: +y!, m: +b!, d: +a! });
      return readings;
    },
  },
  {
    pattern: /(?<!\d)(\d{4})-(\d{1,2})(?![\d-])/g,
    read: ([, y, m]) => (validMonth(+m!) ? [{ y: +y!, m: +m! }] : []),
  },
  { pattern: /(\d{4})\s*年/g, read: ([, y]) => [{ y: +y! }] },
  {
    pattern: /(?<!\d)((?:1[5-9]|20|21)\d{2})(?!\d)/g,
    read: ([, y]) => [{ y: +y! }],
  },
];

/**
 * The dates a text states, in order. Each mention is the list of readings it
 * allows (one, or two for `03/05/2024`); a mention that cannot be read at all
 * (`2024-13-45`) is dropped.
 */
export function extractDates(raw: string): Ymd[][] {
  let text = raw.normalize("NFKC");
  const mentions: { at: number; readings: Ymd[] }[] = [];
  for (const { pattern, read } of DATE_PATTERNS) {
    text = text.replace(pattern, (...args) => {
      const groups = args.slice(0, -2) as string[];
      const at = args[args.length - 2] as number;
      const match = Object.assign(groups, { index: at, input: text }) as unknown as RegExpExecArray;
      const readings = read(match);
      if (readings.length > 0) mentions.push({ at, readings });
      // Blank out the span even when it did not read, so a weaker pattern
      // cannot pick a fragment of it (the year of `2024-13-45`).
      return " ".repeat(groups[0]!.length);
    });
  }
  return mentions.sort((a, b) => a.at - b.at).map((mention) => mention.readings);
}

/** The readings of every date in a value; undefined when it holds none. */
export function parseDate(value: string): Ymd[][] | undefined {
  const mentions = extractDates(value);
  return mentions.length > 0 ? mentions : undefined;
}

function isoOf(reading: Ymd): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return [String(reading.y).padStart(4, "0"), reading.m && pad(reading.m), reading.d && pad(reading.d)]
    .filter(Boolean)
    .join("-");
}

const satisfies = (wanted: Ymd, stated: Ymd) =>
  wanted.y === stated.y &&
  (wanted.m === undefined || wanted.m === stated.m) &&
  (wanted.d === undefined || wanted.d === stated.d);

/**
 * Every date the value states is stated by the passage, at the value's own
 * precision: a value with a day needs the day, a value with only a year needs
 * only the year. The notations may differ.
 */
export function dateCovered(value: string, passage: string): boolean {
  const wanted = parseDate(value);
  if (!wanted) return false;
  const stated = extractDates(passage).flat();
  return wanted.every((readings) =>
    readings.some((reading) => stated.some((other) => satisfies(reading, other))),
  );
}

const precisionOf = (reading: Ymd) => (reading.d !== undefined ? 3 : reading.m !== undefined ? 2 : 1);

/**
 * The date value a cell keeps, given the passage that backs it; undefined when
 * the passage does not support it.
 *
 * - Covered at its own precision (`dateCovered`): the value as written.
 * - Otherwise, a value that reads as exactly one date with one reading, where
 *   the passage states a coarser date that agrees with it (same year, and same
 *   month when the passage gives one): that coarser date, as ISO at the
 *   passage's precision (`2025`, `2025-12`). The most precise agreeing reading
 *   wins. So `2025-12-31` against "截至2025年末" is kept as `2025`.
 *
 * Precision is never invented, a disagreeing year or month is never accepted,
 * and a month without a year (`6月末`) states no date at all.
 */
export function coverDate(value: string, passage: string): string | undefined {
  if (dateCovered(value, passage)) return value;
  const mentions = parseDate(value);
  if (mentions?.length !== 1 || mentions[0]!.length !== 1) return undefined;
  const wanted = mentions[0]![0]!;
  let best: Ymd | undefined;
  for (const stated of extractDates(passage).flat()) {
    if (precisionOf(stated) >= precisionOf(wanted)) continue;
    if (!satisfies(stated, wanted)) continue;
    if (!best || precisionOf(stated) > precisionOf(best)) best = stated;
  }
  return best && isoOf(best);
}

/* ---------------------------------------------------------------- booleans */

const YES = /^(yes|true)(?![a-z])/;
const NO = /^(no|false)(?![a-z])/;

export function parseBoolean(value: string): boolean | undefined {
  const text = value.normalize("NFKC").trim().toLowerCase();
  if (YES.test(text)) return true;
  if (NO.test(text)) return false;
  if (text.startsWith("是否")) return undefined;
  if (/^(不是|没有|没|无|否|不|未)/.test(text)) return false;
  if (/^(是|有|对|会|能)/.test(text)) return true;
  return undefined;
}

/* ------------------------------------------------------------------ values */

/**
 * The sortable value of a cell: a number for a single figure, an ISO date for
 * a single unambiguous date, a boolean for yes or no. Absent when the value
 * does not read as exactly one such thing (and always for `text`).
 */
export function normalizedValue(
  type: TableColumnType,
  value: string,
): number | string | boolean | undefined {
  if (type === "number") {
    const figures = extractFigures(value);
    return figures.length === 1 ? figures[0] : undefined;
  }
  if (type === "date") {
    const mentions = parseDate(value);
    const only = mentions?.length === 1 ? mentions[0] : undefined;
    return only?.length === 1 ? isoOf(only[0]!) : undefined;
  }
  if (type === "boolean") return parseBoolean(value);
  return undefined;
}

/**
 * A key under which two writings of the same value agree: `1,200` and `1.2k`,
 * `March 5, 2024` and `2024-03-05`, `Yes` and `是`; text compares with case,
 * width, punctuation and spaces removed. A value that does not read for its
 * type compares as text.
 */
export function valueKey(type: TableColumnType, value: string): string {
  const normalized = normalizedValue(type, value);
  if (normalized !== undefined) return `${type}:${String(normalized)}`;
  if (type === "date") {
    const mentions = parseDate(value);
    if (mentions) {
      return `date:${mentions.map((readings) => readings.map(isoOf).join("|")).join("+")}`;
    }
  }
  if (type === "number") {
    const figures = extractFigures(value);
    if (figures.length > 0) return `number:${figures.join("+")}`;
  }
  return `text:${normalizeFingerprintText(value)}`;
}
