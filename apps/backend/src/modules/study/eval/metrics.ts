import type {
  MindmapNode,
  QuizItem,
  StudyContent,
  StudyEvidence,
  StudyKind,
} from "@sourceweft/contracts/study";

/**
 * Deterministic metrics of the study evaluation (plan §10 B2). They read only
 * the published content contract and the fixture text, never the engine's own
 * helpers, so an engine defect cannot hide behind the code that measures it.
 */

/** One learner-facing item of any study type, as the metrics see it. */
export type EvalItem = {
  kind: StudyKind;
  id: string;
  /** The text compared for duplicates: card front, question stem, node label. */
  key: string;
  /** Every learner-facing string, for language and injection checks. */
  text: string;
  evidence: StudyEvidence[];
  /** Mind map nodes: levels below the root (1 = a main branch). */
  depth?: number;
};

function nodeItems(node: MindmapNode, depth: number): EvalItem[] {
  const self: EvalItem = {
    kind: "mindmap",
    id: node.id,
    key: node.label,
    text: [node.label, node.summary ?? ""].join(" ").trim(),
    evidence: node.evidence,
    depth,
  };
  return [self, ...node.children.flatMap((child) => nodeItems(child, depth + 1))];
}

function quizText(item: QuizItem) {
  return [
    item.stem,
    ...(item.type === "single" || item.type === "multi" ? (item.options ?? []) : []),
    item.referenceAnswer ?? "",
    item.explanation,
  ]
    .join(" ")
    .trim();
}

/** The items of a content payload; a mind map's root is not an item. */
export function itemsOf(content: StudyContent): EvalItem[] {
  if (content.kind === "mindmap") {
    return content.root.children.flatMap((child) => nodeItems(child, 1));
  }
  if (content.kind === "flashcards") {
    return content.items.map((item) => ({
      kind: "flashcards",
      id: item.id,
      key: item.front,
      text: [item.front, item.back, item.hint ?? ""].join(" ").trim(),
      evidence: item.evidence,
    }));
  }
  return content.items.map((item) => ({
    kind: "quiz",
    id: item.id,
    key: item.stem,
    text: quizText(item),
    evidence: item.evidence,
  }));
}

/** Whitespace runs read as one space, compatibility forms folded. */
function foldSpace(text: string) {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * True when the evidence quote is source text of the chunk it names: the
 * recorded range holds exactly the quote, or (without a range) the chunk
 * contains it word for word, whitespace aside.
 */
export function evidenceInChunk(
  evidence: StudyEvidence,
  chunkTextById: ReadonlyMap<string, string>,
): boolean {
  const text = chunkTextById.get(evidence.chunkId);
  if (text === undefined || evidence.quote.trim().length === 0) return false;
  if (evidence.startChar !== undefined && evidence.endChar !== undefined) {
    return text.slice(evidence.startChar, evidence.endChar) === evidence.quote;
  }
  return foldSpace(text).includes(foldSpace(evidence.quote));
}

export type Ratio = { numerator: number; denominator: number };

export function ratio(numerator: number, denominator: number): Ratio {
  return { numerator, denominator };
}

export function sumRatios(parts: readonly Ratio[]): Ratio {
  return parts.reduce(
    (total, part) => ratio(total.numerator + part.numerator, total.denominator + part.denominator),
    ratio(0, 0),
  );
}

/** null when nothing was measured. */
export function rateOf(value: Ratio): number | null {
  return value.denominator === 0 ? null : value.numerator / value.denominator;
}

/**
 * Evidence anchoring: of the items that carry evidence, how many have every
 * quote inside the chunk it cites. Mind map nodes without evidence (the
 * engine allows them only for grouping nodes) are counted apart.
 */
export function anchoringOf(
  items: readonly EvalItem[],
  chunkTextById: ReadonlyMap<string, string>,
): { anchored: Ratio; withoutEvidence: number } {
  let withEvidence = 0;
  let anchored = 0;
  let withoutEvidence = 0;
  for (const item of items) {
    if (item.evidence.length === 0) {
      withoutEvidence += 1;
      continue;
    }
    withEvidence += 1;
    if (item.evidence.every((entry) => evidenceInChunk(entry, chunkTextById))) {
      anchored += 1;
    }
  }
  return { anchored: ratio(anchored, withEvidence), withoutEvidence };
}

/** Lower case, folded width, no punctuation, symbols or spaces. */
export function normalizeForDuplicates(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{Z}\s]+/gu, "");
}

function trigramSet(text: string): Set<string> {
  const chars = [...normalizeForDuplicates(text)];
  if (chars.length < 3) return new Set(chars.length > 0 ? [chars.join("")] : []);
  const grams = new Set<string>();
  for (let index = 0; index + 3 <= chars.length; index += 1) {
    grams.add(chars.slice(index, index + 3).join(""));
  }
  return grams;
}

/** Character 3-gram Jaccard similarity after normalization. */
export function trigramJaccard(a: string, b: string): number {
  const left = trigramSet(a);
  const right = trigramSet(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** The engine's duplicate threshold (plan §5.1, D-C). */
export const DUPLICATE_JACCARD = 0.8;

/**
 * Near duplicates in a final set: an item counts when its key is at least
 * `threshold` similar to an earlier item's. The rate is per item, so one pair
 * in twenty cards is 5%.
 */
export function duplicatesOf(
  keys: readonly string[],
  threshold = DUPLICATE_JACCARD,
): { duplicates: Ratio; pairs: [number, number][] } {
  const pairs: [number, number][] = [];
  let duplicated = 0;
  keys.forEach((key, index) => {
    let found = false;
    for (let earlier = 0; earlier < index; earlier += 1) {
      if (trigramJaccard(keys[earlier]!, key) >= threshold) {
        pairs.push([earlier, index]);
        found = true;
      }
    }
    if (found) duplicated += 1;
  });
  return { duplicates: ratio(duplicated, keys.length), pairs };
}

/** The first level of a heading path ("A > B" → "A"). */
export function topHeading(headingPath: string): string {
  return headingPath.split(" > ")[0]!.trim();
}

/**
 * Heading coverage: the share of the source's headed sections that at least
 * one item cites. With `level: "top"` sections are first-level headings (the
 * mind map gate); otherwise every distinct heading path counts. `reachable`
 * measures the same sections against what the set could cover at most, the
 * smaller of the section count and the item count: twenty cards cannot cover
 * sixty sections, so a long source is not failed for being long.
 */
export function headingCoverageOf(input: {
  chunks: readonly { chunkId: string; headingPath: string | null }[];
  items: readonly EvalItem[];
  level?: "path" | "top";
}): { covered: Ratio; reachable: Ratio; missing: string[] } | null {
  const sectionOf = (headingPath: string) =>
    input.level === "top" ? topHeading(headingPath) : headingPath;
  const sectionByChunk = new Map<string, string>();
  for (const chunk of input.chunks) {
    if (chunk.headingPath) sectionByChunk.set(chunk.chunkId, sectionOf(chunk.headingPath));
  }
  const sections = new Set(sectionByChunk.values());
  if (sections.size === 0) return null;
  const cited = new Set<string>();
  for (const item of input.items) {
    for (const entry of item.evidence) {
      const section = sectionByChunk.get(entry.chunkId);
      if (section) cited.add(section);
    }
  }
  const missing = [...sections].filter((section) => !cited.has(section));
  const coveredCount = sections.size - missing.length;
  return {
    covered: ratio(coveredCount, sections.size),
    reachable: ratio(coveredCount, Math.min(sections.size, input.items.length)),
    missing,
  };
}

const HAN = /\p{Script=Han}/u;
const LATIN = /\p{Script=Latin}/u;

/**
 * The dominant script of a text, counting each Han character as one unit and
 * each run of Latin letters (a word) as one unit, so Chinese text that keeps
 * English names is still Chinese and English text with a quoted Chinese term
 * is still English. Null when it has neither.
 */
export function dominantScript(text: string): "zh" | "en" | null {
  let han = 0;
  let latinWords = 0;
  let inWord = false;
  for (const char of text) {
    if (HAN.test(char)) {
      han += 1;
      inWord = false;
    } else if (LATIN.test(char)) {
      if (!inWord) latinWords += 1;
      inWord = true;
    } else if (!/['’-]/u.test(char)) {
      inWord = false;
    }
  }
  if (han === 0 && latinWords === 0) return null;
  return han >= latinWords ? "zh" : "en";
}

/** Language correctness: items whose dominant script is the requested language's. */
export function languageCorrectnessOf(
  items: readonly EvalItem[],
  language: string,
): Ratio | null {
  const expected = language.toLowerCase().split(/[-_]/)[0];
  if (expected !== "zh" && expected !== "en") return null;
  let judged = 0;
  let correct = 0;
  for (const item of items) {
    const script = dominantScript(item.text);
    if (script === null) continue;
    judged += 1;
    if (script === expected) correct += 1;
  }
  return ratio(correct, judged);
}

/** Items whose text carries a planted canary (case and width folded). */
export function injectionHitsOf(
  items: readonly EvalItem[],
  canaries: readonly string[],
): string[] {
  const folded = canaries.map((canary) => canary.normalize("NFKC").toLowerCase());
  return items
    .filter((item) => {
      const text = item.text.normalize("NFKC").toLowerCase();
      return folded.some((canary) => text.includes(canary));
    })
    .map((item) => item.id);
}

/** The engine's leak ratio (plan §5.4 step 6). */
export const LEAK_LENGTH_RATIO = 1.6;

export type QuizLeak = {
  id: string;
  longCorrect: boolean;
  stemHasAnswer: boolean;
};

/**
 * Answer leaks of choice questions: the correct option much longer than the
 * others' mean, or the correct option's text inside the stem. Position bias
 * is a property of the whole set; see `positionBiasOf`.
 */
export function quizLeaksOf(items: readonly QuizItem[]): QuizLeak[] {
  return items
    .filter((item) => (item.type === "single" || item.type === "multi") && item.options)
    .map((item) => {
      const options = item.options!;
      const correct = new Set(item.correct ?? []);
      const length = (text: string) => [...text].length;
      const right = options.filter((_, index) => correct.has(index));
      const wrong = options.filter((_, index) => !correct.has(index));
      const mean = (values: string[]) =>
        values.reduce((sum, value) => sum + length(value), 0) / values.length;
      const longCorrect =
        wrong.length > 0 && right.length > 0 && mean(right) > mean(wrong) * LEAK_LENGTH_RATIO;
      const stem = normalizeForDuplicates(item.stem);
      const stemHasAnswer = right.some((option) => {
        const answer = normalizeForDuplicates(option);
        // Very short answers ("5", "No") appear in stems by chance.
        return answer.length >= 4 && stem.includes(answer);
      });
      return { id: item.id, longCorrect, stemHasAnswer };
    });
}

/** Upper 5% points of the chi-square distribution, by degrees of freedom. */
const CHI_SQUARE_95 = [
  0, 3.841, 5.991, 7.815, 9.488, 11.07, 12.592, 14.067, 15.507, 16.919, 18.307,
  19.675, 21.026, 22.362, 23.685, 24.996, 26.296, 27.587, 28.869, 30.144, 31.41,
];

/**
 * Whether the correct option's position is biased across single-answer
 * questions: a chi-square goodness-of-fit test against "every position
 * equally likely", pooled over questions with the same option count. With
 * fewer than five expected answers per position the test is not run.
 */
export function positionBiasOf(items: readonly QuizItem[]): {
  tested: number;
  statistic: number;
  degreesOfFreedom: number;
  critical: number;
  biased: boolean;
  counts: Record<string, number[]>;
} | null {
  const byOptionCount = new Map<number, number[]>();
  for (const item of items) {
    if (item.type !== "single" || !item.options || item.correct?.length !== 1) continue;
    const size = item.options.length;
    const counts = byOptionCount.get(size) ?? new Array<number>(size).fill(0);
    counts[item.correct[0]!]! += 1;
    byOptionCount.set(size, counts);
  }
  let statistic = 0;
  let degreesOfFreedom = 0;
  let tested = 0;
  const counts: Record<string, number[]> = {};
  for (const [size, observed] of byOptionCount) {
    const total = observed.reduce((a, b) => a + b, 0);
    counts[String(size)] = observed;
    const expected = total / size;
    if (expected < 5) continue;
    tested += total;
    degreesOfFreedom += size - 1;
    for (const value of observed) statistic += (value - expected) ** 2 / expected;
  }
  if (degreesOfFreedom === 0 || degreesOfFreedom >= CHI_SQUARE_95.length) {
    return null;
  }
  const critical = CHI_SQUARE_95[degreesOfFreedom]!;
  return {
    tested,
    statistic,
    degreesOfFreedom,
    critical,
    biased: statistic > critical,
    counts,
  };
}

/** The p-th percentile (0–100) by nearest rank; null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
