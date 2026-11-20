import { extractFigures } from "../../citations/figures";

/**
 * Scoring for the data table evaluation (`scripts/eval-table.ts --score`):
 * compares each run's cells with a human-labelled reference table, cell by
 * cell, and turns the comparison into the metrics the entry gate is set on.
 *
 * Pure: no I/O, no model, no database. The rules are deliberately independent
 * of the engine's own normalisation, so the evaluation does not grade the
 * engine with its own ruler.
 *
 * - number: figures read the way citation anchoring reads them
 *   (`figures.ts`: `1,200`, `1.2k`, `12亿`, `1.2 billion`), plus `M`/`bn`
 *   suffixes, a leading minus and percentages; equal within 0.5% relative.
 * - date: normalised to ISO at the granularity the reference states (year,
 *   year-month or day); an answer coarser than the reference does not match.
 * - boolean: yes/no/true/false/是/否 (and 有/没有/无/不是).
 * - text: equal after whitespace and case normalisation, otherwise a person
 *   judges it (`needs_judgment`); an unjudged cell is never a match.
 *
 * A value a typed rule cannot read also `needs_judgment`.
 */

export type EvalColumnType = "text" | "number" | "date" | "boolean";

/* ------------------------------------------------------------------ numbers */

export type ParsedNumber = { values: number[]; percent: boolean };

const PERCENT = /%|\bper\s?cent\b|\bpercent\b|百分之/i;

/** The figures a value states, or null when it states none. */
export function parseNumberValue(raw: string): ParsedNumber | null {
  let text = raw.normalize("NFKC").trim();
  // `$1.2M`, `3bn`: suffixes figures.ts leaves alone. Case-sensitive for M/B so
  // that "5 m" (metres) keeps its plain figure.
  text = text
    .replace(/(\d)\s?(?:M|MM|mn)(?![A-Za-z])/g, "$1 million")
    .replace(/(\d)\s?(?:B|bn|Bn)(?![A-Za-z])/g, "$1 billion");
  const values = extractFigures(text);
  if (values.length === 0) return null;
  if (/^[-−–]\s*\d/.test(text)) values[0] = -values[0]!;
  return { values, percent: PERCENT.test(text) };
}

const NUMBER_TOLERANCE = 0.005;

function closeEnough(a: number, b: number) {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 || Math.abs(a - b) <= NUMBER_TOLERANCE * scale;
}

/**
 * Whether two values state the same figures within 0.5% relative. Null when
 * either states no figure or they state a different number of figures.
 */
export function numbersMatch(reference: string, answer: string): boolean | null {
  const ref = parseNumberValue(reference);
  const got = parseNumberValue(answer);
  if (!ref || !got || ref.values.length !== got.values.length) return null;
  // "35%" and "0.35": the plain side is a fraction when every figure is ≤ 1.
  const scale = (side: ParsedNumber, other: ParsedNumber) =>
    !side.percent && other.percent && side.values.every((v) => Math.abs(v) <= 1) ? 100 : 1;
  const refScale = scale(ref, got);
  const gotScale = scale(got, ref);
  return ref.values.every((value, index) =>
    closeEnough(value * refScale, got.values[index]! * gotScale),
  );
}

/* -------------------------------------------------------------------- dates */

export type DateGranularity = "year" | "month" | "day";
export type ParsedDate = { granularity: DateGranularity; iso: string };

const MONTH =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthOf = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;

type Ymd = { y: number; m?: number; d?: number };
type Reading = Ymd | "ambiguous" | null;

const validMonth = (m: number) => m >= 1 && m <= 12;
const validDay = (d: number) => d >= 1 && d <= 31;
const ymd = (y: number, m: number, d: number): Reading =>
  validMonth(m) && validDay(d) ? { y, m, d } : null;

const DATE_PATTERNS: { pattern: RegExp; read: (groups: string[]) => Reading }[] = [
  {
    // 2023-05-12, 2023/5/12, 2023.05.12, 2023年5月12日
    pattern: /(?<!\d)(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号號]?(?!\d)/g,
    read: ([y, m, d]) => ymd(+y!, +m!, +d!),
  },
  {
    pattern: new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"),
    read: ([month, d, y]) => ymd(+y!, monthOf(month!), +d!),
  },
  {
    pattern: new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})\\.?,?\\s+(\\d{4})\\b`,
      "gi",
    ),
    read: ([d, month, y]) => ymd(+y!, monthOf(month!), +d!),
  },
  {
    // 25/12/2023 is day-first, 12/25/2023 month-first, 05/06/2023 either.
    pattern: /(?<!\d)(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)/g,
    read: ([a, b, y]) => {
      const first = +a!;
      const second = +b!;
      if (first === second) return ymd(+y!, first, second);
      if (first > 12) return ymd(+y!, second, first);
      if (second > 12) return ymd(+y!, first, second);
      return "ambiguous";
    },
  },
  {
    pattern: /(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月/g,
    read: ([y, m]) => (validMonth(+m!) ? { y: +y!, m: +m! } : null),
  },
  {
    pattern: /(?<!\d)(\d{4})[-/.](\d{1,2})(?![\d])/g,
    read: ([y, m]) => (validMonth(+m!) ? { y: +y!, m: +m! } : null),
  },
  {
    pattern: new RegExp(`\\b(${MONTH})\\.?,?\\s+(\\d{4})\\b`, "gi"),
    read: ([month, y]) => ({ y: +y!, m: monthOf(month!) }),
  },
  {
    pattern: /(?<!\d)(\d{4})\s*年?(?!\d)/g,
    read: ([y]) => (+y! >= 1000 && +y! <= 2999 ? { y: +y! } : null),
  },
];

const pad = (n: number) => String(n).padStart(2, "0");

function toParsed(date: Ymd): ParsedDate {
  if (date.m === undefined) return { granularity: "year", iso: String(date.y) };
  if (date.d === undefined) return { granularity: "month", iso: `${date.y}-${pad(date.m)}` };
  return { granularity: "day", iso: `${date.y}-${pad(date.m)}-${pad(date.d)}` };
}

/**
 * The one date a value states, at the granularity it states it. Null when it
 * states none, several different ones, or one that reads day-first and
 * month-first alike.
 */
export function parseDateValue(raw: string): ParsedDate | null {
  let text = raw.normalize("NFKC");
  const readings: Reading[] = [];
  for (const { pattern, read } of DATE_PATTERNS) {
    text = text.replace(pattern, (...args: unknown[]) => {
      // (match, ...groups, offset, input): every group of these patterns takes part.
      readings.push(read(args.slice(1, -2) as string[]));
      return " ";
    });
  }
  if (readings.includes("ambiguous")) return null;
  const dates = [...new Map(
    readings
      .filter((reading): reading is Ymd => reading !== null && reading !== "ambiguous")
      .map((date) => {
        const parsed = toParsed(date);
        return [parsed.iso, parsed] as const;
      }),
  ).values()];
  return dates.length === 1 ? dates[0]! : null;
}

const GRANULARITY_RANK: Record<DateGranularity, number> = { year: 0, month: 1, day: 2 };
const ISO_LENGTH: Record<DateGranularity, number> = { year: 4, month: 7, day: 10 };

/** Equal at the reference's granularity; null when either side is unreadable. */
export function datesMatch(reference: string, answer: string): boolean | null {
  const ref = parseDateValue(reference);
  const got = parseDateValue(answer);
  if (!ref || !got) return null;
  if (GRANULARITY_RANK[got.granularity] < GRANULARITY_RANK[ref.granularity]) return false;
  return got.iso.slice(0, ISO_LENGTH[ref.granularity]) === ref.iso;
}

/* ----------------------------------------------------------------- booleans */

export function parseBooleanValue(raw: string): boolean | null {
  const text = raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "");
  if (/^(yes|true)(?![a-z])/.test(text)) return true;
  if (/^(no|false)(?![a-z])/.test(text)) return false;
  if (text.startsWith("是否")) return null;
  if (/^(不是|没有|沒有|没|沒|无|無|否|不)/.test(text)) return false;
  if (/^(是|有|对|對)/.test(text)) return true;
  return null;
}

export function booleansMatch(reference: string, answer: string): boolean | null {
  const ref = parseBooleanValue(reference);
  const got = parseBooleanValue(answer);
  return ref === null || got === null ? null : ref === got;
}

/* --------------------------------------------------------------------- text */

function normalizeText(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export type RuleVerdict = "match" | "mismatch" | "needs_judgment";

/** The rule's verdict on two found values of one column type. */
export function ruleVerdict(type: EvalColumnType, reference: string, answer: string): RuleVerdict {
  if (normalizeText(reference) === normalizeText(answer)) return "match";
  if (type === "text") return "needs_judgment";
  const result =
    type === "number"
      ? numbersMatch(reference, answer)
      : type === "date"
        ? datesMatch(reference, answer)
        : booleansMatch(reference, answer);
  return result === null ? "needs_judgment" : result ? "match" : "mismatch";
}

/* ------------------------------------------------------------------ scoring */

export type ReferenceCell = {
  status: "found" | "not_found";
  value?: string;
  quote?: string;
};

export type EvalSetScoreInput = {
  id: string;
  columns: { id: string; type: EvalColumnType }[];
  /** In selection order. */
  sourceIds: string[];
  /** By source id, then column id. A missing entry is an unlabelled cell. */
  reference: Record<string, Record<string, ReferenceCell>>;
};

export type GotCell = {
  status: "found" | "not_found" | "unverified";
  value?: string;
};

export type EvalRunScoreInput = {
  setId: string;
  run: number;
  /** A failed run (e.g. GENERATION_QUALITY_TOO_LOW) is a result, not a crash. */
  status: "ok" | "failed";
  errorCode?: string;
  rowStatus: Record<string, "ok" | "failed" | "skipped">;
  /** By source id, then the set's column id. */
  cells: Record<string, Record<string, GotCell>>;
  usage: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    /** Null when the cost of at least one call is unknown. */
    costUsd: number | null;
  };
};

export type GotStatus =
  | GotCell["status"]
  | "row_failed"
  | "row_skipped"
  | "run_failed"
  | "missing";

export type CellVerdict =
  | RuleVerdict
  | "miss"
  | "wrong_fill"
  | "agree_not_found"
  | "unverified"
  | "row_failed"
  | "row_skipped"
  | "run_failed"
  | "missing"
  | "unlabelled";

export type ScoredCell = {
  set: string;
  run: number;
  source: string;
  column: string;
  type: EvalColumnType;
  ref_status: ReferenceCell["status"] | "unlabelled";
  ref_value: string;
  got_status: GotStatus;
  got_value: string;
  /** What the rules decide. */
  rule_verdict: CellVerdict;
  /** After the judgments file fills `needs_judgment`. */
  final_verdict: CellVerdict;
};

export type Judgments = Record<string, "match" | "mismatch">;

export function judgmentKey(set: string, run: number, source: string, column: string) {
  return `${set}/${run}/${source}/${column}`;
}

type Counters = {
  runs: number;
  successfulRuns: number;
  failedRunCodes: Record<string, number>;
  refFound: number;
  refNotFound: number;
  /** Positions (source × column) the reference does not label. */
  unlabelled: number;
  filled: number;
  found: number;
  unverified: number;
  matched: number;
  mismatched: number;
  unjudged: number;
  missed: number;
  wrongFill: number;
  rowFailedCells: number;
  numberBothFound: number;
  numberMatched: number;
  numberUnjudged: number;
  /** Labelled-found positions times every run, failed ones included. */
  refFoundInclFailed: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  runsWithoutCost: number;
  runAgreements: number[];
};

export type ScoreMetrics = Omit<Counters, "runAgreements"> & {
  runSuccessRate: number | null;
  agreementRate: number | null;
  /** Agreement if every unjudged cell turned out to match. */
  agreementUpperBound: number | null;
  /** Failed runs count as runs where nothing agreed. */
  agreementRateInclFailedRuns: number | null;
  missRate: number | null;
  wrongFillRate: number | null;
  unverifiedShare: number | null;
  numberExactRate: number | null;
  /** Range of the per-run agreement over successful runs. */
  agreementMin: number | null;
  agreementMax: number | null;
};

export type ScoreResult = {
  sets: { id: string; metrics: ScoreMetrics }[];
  overall: ScoreMetrics;
  cells: ScoredCell[];
  /** Judgment keys that name no needs_judgment cell. */
  unusedJudgments: string[];
};

function emptyCounters(): Counters {
  return {
    runs: 0,
    successfulRuns: 0,
    failedRunCodes: {},
    refFound: 0,
    refNotFound: 0,
    unlabelled: 0,
    filled: 0,
    found: 0,
    unverified: 0,
    matched: 0,
    mismatched: 0,
    unjudged: 0,
    missed: 0,
    wrongFill: 0,
    rowFailedCells: 0,
    numberBothFound: 0,
    numberMatched: 0,
    numberUnjudged: 0,
    refFoundInclFailed: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    runsWithoutCost: 0,
    runAgreements: [],
  };
}

const ratio = (n: number, d: number) => (d > 0 ? n / d : null);

function toMetrics(counters: Counters): ScoreMetrics {
  const { runAgreements, ...rest } = counters;
  return {
    ...rest,
    runSuccessRate: ratio(counters.successfulRuns, counters.runs),
    agreementRate: ratio(counters.matched, counters.refFound),
    agreementUpperBound: ratio(counters.matched + counters.unjudged, counters.refFound),
    agreementRateInclFailedRuns: ratio(counters.matched, counters.refFoundInclFailed),
    missRate: ratio(counters.missed, counters.refFound),
    wrongFillRate: ratio(counters.wrongFill, counters.refNotFound),
    unverifiedShare: ratio(counters.unverified, counters.found + counters.unverified),
    numberExactRate: ratio(counters.numberMatched, counters.numberBothFound),
    agreementMin: runAgreements.length ? Math.min(...runAgreements) : null,
    agreementMax: runAgreements.length ? Math.max(...runAgreements) : null,
  };
}

function addCounters(into: Counters, from: Counters) {
  for (const key of Object.keys(from) as (keyof Counters)[]) {
    if (key === "failedRunCodes") {
      for (const [code, count] of Object.entries(from.failedRunCodes)) {
        into.failedRunCodes[code] = (into.failedRunCodes[code] ?? 0) + count;
      }
    } else if (key === "runAgreements") {
      into.runAgreements.push(...from.runAgreements);
    } else {
      (into[key] as number) += from[key] as number;
    }
  }
}

function gotOf(
  run: EvalRunScoreInput,
  source: string,
  column: string,
): { status: GotStatus; value: string } {
  if (run.status === "failed") return { status: "run_failed", value: "" };
  const row = run.rowStatus[source];
  if (row === "failed") return { status: "row_failed", value: "" };
  if (row === "skipped") return { status: "row_skipped", value: "" };
  const cell = run.cells[source]?.[column];
  if (!cell) return { status: "missing", value: "" };
  return { status: cell.status, value: cell.status === "found" ? (cell.value ?? "") : "" };
}

function verdictOf(
  type: EvalColumnType,
  ref: ReferenceCell | undefined,
  got: { status: GotStatus; value: string },
): CellVerdict {
  if (!ref) return "unlabelled";
  switch (got.status) {
    case "run_failed":
    case "row_failed":
    case "row_skipped":
    case "missing":
    case "unverified":
      return got.status;
    case "not_found":
      return ref.status === "found" ? "miss" : "agree_not_found";
    case "found":
      return ref.status === "found"
        ? ruleVerdict(type, ref.value ?? "", got.value)
        : "wrong_fill";
  }
}

/**
 * Scores every run against its set's reference. Cell metrics come from the
 * successful runs; a failed run adds to the run success rate, to the spend
 * and to `agreementRateInclFailedRuns`, and its cells appear in the CSV as
 * `run_failed`. A row that failed inside a successful run counts against
 * agreement (its cells are labelled but never match) without being a miss.
 */
export function scoreRuns(input: {
  sets: readonly EvalSetScoreInput[];
  runs: readonly EvalRunScoreInput[];
  judgments?: Judgments;
}): ScoreResult {
  const judgments = new Map<string, "match" | "mismatch">();
  for (const [key, value] of Object.entries(input.judgments ?? {})) {
    // "set/run-1/source/column" and "set/1/source/column" name the same cell.
    judgments.set(key.replace(/^([^/]+)\/run-(\d+)\//, "$1/$2/"), value);
  }
  const usedJudgments = new Set<string>();
  const cells: ScoredCell[] = [];
  const sets: ScoreResult["sets"] = [];
  const overall = emptyCounters();

  for (const set of input.sets) {
    const counters = emptyCounters();
    const runs = input.runs
      .filter((run) => run.setId === set.id)
      .sort((a, b) => a.run - b.run);
    const typeOf = new Map(set.columns.map((column) => [column.id, column.type]));
    let labelledFound = 0;
    for (const source of set.sourceIds) {
      for (const column of set.columns) {
        const ref = set.reference[source]?.[column.id];
        if (!ref) counters.unlabelled += 1;
        else if (ref.status === "found") labelledFound += 1;
      }
    }

    for (const run of runs) {
      counters.runs += 1;
      counters.calls += run.usage.calls;
      counters.inputTokens += run.usage.inputTokens;
      counters.outputTokens += run.usage.outputTokens;
      if (run.usage.costUsd === null) counters.runsWithoutCost += 1;
      else counters.costUsd += run.usage.costUsd;
      counters.refFoundInclFailed += labelledFound;
      if (run.status === "failed") {
        const code = run.errorCode ?? "UNKNOWN";
        counters.failedRunCodes[code] = (counters.failedRunCodes[code] ?? 0) + 1;
      } else {
        counters.successfulRuns += 1;
      }

      let runMatched = 0;
      for (const source of set.sourceIds) {
        for (const column of set.columns) {
          const type = typeOf.get(column.id)!;
          const ref = set.reference[source]?.[column.id];
          const got = gotOf(run, source, column.id);
          const rule = verdictOf(type, ref, got);
          let final = rule;
          if (rule === "needs_judgment") {
            const key = judgmentKey(set.id, run.run, source, column.id);
            const judged = judgments.get(key);
            if (judged) {
              final = judged;
              usedJudgments.add(key);
            }
          }
          cells.push({
            set: set.id,
            run: run.run,
            source,
            column: column.id,
            type,
            ref_status: ref ? ref.status : "unlabelled",
            ref_value: ref?.status === "found" ? (ref.value ?? "") : "",
            got_status: got.status,
            got_value: got.value,
            rule_verdict: rule,
            final_verdict: final,
          });
          if (!ref || run.status === "failed") continue;

          if (ref.status === "found") counters.refFound += 1;
          else counters.refNotFound += 1;
          if (got.status === "found") {
            counters.filled += 1;
            counters.found += 1;
          } else if (got.status === "unverified") {
            counters.unverified += 1;
          } else if (
            got.status === "row_failed" ||
            got.status === "row_skipped" ||
            got.status === "missing"
          ) {
            counters.rowFailedCells += 1;
          }
          if (final === "match") {
            counters.matched += 1;
            runMatched += 1;
          } else if (final === "mismatch") counters.mismatched += 1;
          else if (final === "needs_judgment") counters.unjudged += 1;
          else if (final === "miss") counters.missed += 1;
          else if (final === "wrong_fill") counters.wrongFill += 1;

          if (type === "number" && ref.status === "found" && got.status === "found") {
            counters.numberBothFound += 1;
            if (final === "match") counters.numberMatched += 1;
            else if (final === "needs_judgment") counters.numberUnjudged += 1;
          }
        }
      }
      if (run.status === "ok" && labelledFound > 0) {
        counters.runAgreements.push(runMatched / labelledFound);
      }
    }
    sets.push({ id: set.id, metrics: toMetrics(counters) });
    addCounters(overall, counters);
  }

  return {
    sets,
    overall: toMetrics(overall),
    cells,
    unusedJudgments: [...judgments.keys()].filter((key) => !usedJudgments.has(key)),
  };
}

/* ------------------------------------------------------------------- output */

const CSV_COLUMNS = [
  "set",
  "run",
  "source",
  "column",
  "type",
  "ref_status",
  "ref_value",
  "got_status",
  "got_value",
  "rule_verdict",
] as const satisfies readonly (keyof ScoredCell)[];

function csvField(value: string | number) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One line per cell, RFC 4180, CRLF line ends. */
export function cellsToCsv(cells: readonly ScoredCell[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const cell of cells) {
    lines.push(CSV_COLUMNS.map((column) => csvField(cell[column])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

const pct = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
const usd = (metrics: ScoreMetrics) =>
  metrics.runs > 0 && metrics.runsWithoutCost === metrics.runs
    ? "unknown"
    : `$${metrics.costUsd.toFixed(4)}${metrics.runsWithoutCost ? ` (+${metrics.runsWithoutCost} run(s) with unknown cost)` : ""}`;
const md = (value: string) => value.replaceAll("|", "\\|").replace(/\s+/g, " ").slice(0, 120);

function metricsTable(metrics: ScoreMetrics): string[] {
  const rows: [string, string][] = [
    ["Runs (successful / total)", `${metrics.successfulRuns} / ${metrics.runs} (${pct(metrics.runSuccessRate)})`],
    ["Failed runs by code", Object.entries(metrics.failedRunCodes).map(([code, n]) => `${code} × ${n}`).join(", ") || "none"],
    ["Filled cells (found)", String(metrics.filled)],
    ["Agreement (ref found ∧ got found ∧ match) / ref found", pct(metrics.agreementRate)],
    ["Agreement upper bound (unjudged counted as match)", pct(metrics.agreementUpperBound)],
    ["Agreement counting failed runs as zero", pct(metrics.agreementRateInclFailedRuns)],
    ["Per-run agreement min – max", `${pct(metrics.agreementMin)} – ${pct(metrics.agreementMax)}`],
    ["Miss rate (ref found ∧ got not_found) / ref found", pct(metrics.missRate)],
    ["Wrong-fill rate (ref not_found ∧ got found) / ref not_found", pct(metrics.wrongFillRate)],
    ["Unverified share unverified / (found + unverified)", pct(metrics.unverifiedShare)],
    ["Number exact rate (both found)", `${pct(metrics.numberExactRate)} of ${metrics.numberBothFound} (${metrics.numberUnjudged} unjudged)`],
    ["Unjudged cells", String(metrics.unjudged)],
    ["Cells in failed/skipped rows or missing", String(metrics.rowFailedCells)],
    ["Reference found / not_found / unlabelled positions", `${metrics.refFound} / ${metrics.refNotFound} / ${metrics.unlabelled}`],
    ["Model calls", String(metrics.calls)],
    ["Input / output tokens (reported usage)", `${metrics.inputTokens} / ${metrics.outputTokens}`],
    ["Cost", usd(metrics)],
  ];
  return ["| Metric | Value |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${v} |`)];
}

function examples(cells: readonly ScoredCell[], verdict: CellVerdict, limit = 20): string[] {
  const picked = cells.filter((cell) => cell.final_verdict === verdict).slice(0, limit);
  if (picked.length === 0) return ["None."];
  return [
    "| set | run | source | column | type | reference | got |",
    "|---|---|---|---|---|---|---|",
    ...picked.map(
      (cell) =>
        `| ${md(cell.set)} | ${cell.run} | ${md(cell.source)} | ${md(cell.column)} | ${cell.type} | ${md(cell.ref_value) || cell.ref_status} | ${md(cell.got_value) || cell.got_status} |`,
    ),
  ];
}

/** The markdown report of one scoring pass. */
export function formatScoreReport(
  result: ScoreResult,
  meta: { generatedAt: string; judgmentsFile: string | null; resultsDir?: string },
): string {
  const lines: string[] = [
    "# Data table evaluation: scores",
    "",
    `Generated ${meta.generatedAt}.${meta.resultsDir ? ` Results: \`${meta.resultsDir}\`.` : ""} Judgments: ${meta.judgmentsFile ? `\`${meta.judgmentsFile}\`` : "none"}.`,
    "",
    `Unjudged cells: ${result.overall.unjudged}. They are never counted as matches; the agreement upper bound shows what they could add.`,
    ...(result.unusedJudgments.length
      ? ["", `Judgments that name no cell needing one (ignored): ${result.unusedJudgments.length}.`]
      : []),
    "",
    "## Overall",
    "",
    ...metricsTable(result.overall),
    "",
    "## Per set",
    "",
    "| Set | Runs ok | Filled | Agreement | Upper bound | Run min – max | Miss | Wrong fill | Unverified | Number exact | Unjudged | Calls | Tokens in / out | Cost |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...result.sets.map(
      ({ id, metrics: m }) =>
        `| ${md(id)} | ${m.successfulRuns}/${m.runs} | ${m.filled} | ${pct(m.agreementRate)} | ${pct(m.agreementUpperBound)} | ${pct(m.agreementMin)} – ${pct(m.agreementMax)} | ${pct(m.missRate)} | ${pct(m.wrongFillRate)} | ${pct(m.unverifiedShare)} | ${pct(m.numberExactRate)} | ${m.unjudged} | ${m.calls} | ${m.inputTokens} / ${m.outputTokens} | ${usd(m)} |`,
    ),
    "",
    "## Failed runs",
    "",
    ...(() => {
      const failed = result.sets.flatMap(({ id, metrics }) =>
        Object.entries(metrics.failedRunCodes).map(([code, n]) => `- ${id}: ${code} × ${n}`),
      );
      return failed.length ? failed : ["None."];
    })(),
    "",
    "## Mismatches",
    "",
    ...examples(result.cells, "mismatch"),
    "",
    "## Misses (reference found, got not_found)",
    "",
    ...examples(result.cells, "miss"),
    "",
    "## Wrong fills (reference not_found, got found)",
    "",
    ...examples(result.cells, "wrong_fill"),
    "",
    "## Cells needing a judgment",
    "",
    ...examples(result.cells, "needs_judgment", 50),
    "",
    "## Rules",
    "",
    "- number: same figures within 0.5% relative (`1,200` = `1.2k`, `12亿` = `1.2 billion`, `35%` = `0.35`).",
    "- date: ISO at the reference's granularity; an answer coarser than the reference is a mismatch.",
    "- boolean: yes/no/true/false/是/否 (and 有/没有/无/不是).",
    "- text: equal after whitespace/case normalisation, else a person judges it.",
    "- A value a typed rule cannot read needs a judgment. Cell metrics use successful runs only; spend includes failed runs.",
    "",
  ];
  return lines.join("\n");
}
