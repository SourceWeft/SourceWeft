import { extractFigures, figuresCovered } from "./figures";
import type { CitationAnchor } from "./anchoring";

/**
 * Second pass for citations the word matcher cannot judge: a claim and a
 * source in different languages share no words. The claim and the source's
 * sentences are compared by meaning (a multilingual embedding), and the most
 * similar sentence counts as support only when it is clearly the best match
 * AND states every figure the claim states. Anything less stays "not
 * located", so the failure mode is a missing highlight, never a wrong one.
 *
 * Thresholds come from a measurement on cross-language cases (see #516) and
 * are code constants, not settings.
 */
export const SEMANTIC_MIN_SIMILARITY = 0.7;
export const SEMANTIC_MIN_MARGIN = 0.15;
/** Bounds on one answer's embedding call: texts, characters, sentences per source. */
export const SEMANTIC_MAX_TEXTS = 160;
export const SEMANTIC_MAX_CHARS = 30_000;
export const SEMANTIC_MAX_SEGMENTS_PER_CHUNK = 40;
const SEGMENT_TEXT_MAX_CHARS = 400;

export type TextScript = "cjk" | "latin" | "other";

const CJK_LETTER = /[぀-ヿ㐀-䶿一-鿿가-힯]/g;
const LATIN_LETTER = /[A-Za-z]/g;

/** The dominant script of a text, from a leading sample. */
export function scriptOf(text: string): TextScript {
  const sample = text.slice(0, 2000);
  const cjk = sample.match(CJK_LETTER)?.length ?? 0;
  const latin = sample.match(LATIN_LETTER)?.length ?? 0;
  if (cjk + latin < 3) return "other";
  return cjk / (cjk + latin) > 0.3 ? "cjk" : "latin";
}

/** The word matcher cannot see across scripts, so only these pairs get the second pass. */
export function needsSemanticPass(claim: string, content: string) {
  const claimScript = scriptOf(claim);
  const contentScript = scriptOf(content);
  return (
    claimScript !== "other" &&
    contentScript !== "other" &&
    claimScript !== contentScript
  );
}

/** What is embedded for a stretch of source text: markup removed, whitespace collapsed, bounded. */
export function segmentTextForEmbedding(text: string) {
  const clean = text
    .replace(/<[^>]+>/g, " ")
    // A table row's pipes are layout; "Team | 25 | $49" reads as "Team, 25, $49".
    .replace(/^\s*\|\s*|\s*\|\s*$/g, "")
    .replace(/\s*\|\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > SEGMENT_TEXT_MAX_CHARS
    ? clean.slice(0, SEGMENT_TEXT_MAX_CHARS)
    : clean;
}

function cosine(a: readonly number[], b: readonly number[]) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!;
    normA += a[index]! ** 2;
    normB += b[index]! ** 2;
  }
  const denominator = Math.sqrt(normA * normB);
  return denominator === 0 ? 0 : dot / denominator;
}

const UP =
  /\b(rose|rise[sn]?|rising|grew|grow[sn]?|growing|growth|increas(?:e[sd]?|ing)|improv(?:e[sd]?|ing)|gain(?:ed|s)?|surg(?:e[sd]?|ing)|climb(?:ed|s)?|expanded?)\b|增长|增加|上升|提高|提升|上涨|增至|升至|增多|扩大|改善/i;
const DOWN =
  /\b(fell|fall[sn]?|falling|drop(?:ped|s)?|declin(?:e[sd]?|ing)|decreas(?:e[sd]?|ing)|reduc(?:e[sd]?|ing)|shr[au]nk|shrink(?:s|ing)?|lower(?:ed)?|slump(?:ed|s)?)\b|下降|降低|减少|下跌|降至|减至|缩小|下滑|回落/i;

/**
 * The claim and the passage state the same figures but one says it went up
 * and the other down. Meaning-based matching sees them as near twins, so this
 * is checked by direction words in both languages. A sentence that mentions
 * both directions, or neither, is not judged.
 */
export function directionsConflict(claim: string, passage: string) {
  const direction = (text: string) => {
    const up = UP.test(text);
    const down = DOWN.test(text);
    return up === down ? null : up ? "up" : "down";
  };
  const wanted = direction(claim);
  const found = direction(passage);
  return wanted !== null && found !== null && wanted !== found;
}

export type EmbeddedSegment = {
  start: number;
  end: number;
  /** The text of this stretch of the source, as embedded. */
  text: string;
  vector: readonly number[];
};

export function pickSemanticAnchor(input: {
  claim: string;
  claimVector: readonly number[];
  content: string;
  segments: readonly EmbeddedSegment[];
}): CitationAnchor | null {
  if (input.segments.length === 0) return null;
  const ranked = input.segments
    .map((segment) => ({
      segment,
      similarity: cosine(input.claimVector, segment.vector),
    }))
    .sort((a, b) => b.similarity - a.similarity);
  const similar = ranked.filter(
    (item) => item.similarity >= SEMANTIC_MIN_SIMILARITY,
  );
  if (similar.length === 0) return null;
  const stated = (item: (typeof ranked)[number]) =>
    figuresCovered(input.claim, item.segment.text) &&
    !directionsConflict(input.claim, item.segment.text);
  // Two or more figures that only one sentence states identify it, even when
  // sentences that read alike (the rows of a table) tie on meaning.
  const figureCount = extractFigures(input.claim).length;

  let best = similar[0]!;
  if (stated(best)) {
    const margin =
      ranked.length > 1 ? best.similarity - ranked[1]!.similarity : Infinity;
    if (
      margin < SEMANTIC_MIN_MARGIN &&
      !(figureCount >= 2 && similar.filter(stated).length === 1)
    ) {
      return null;
    }
  } else {
    const candidates = figureCount >= 2 ? similar.filter(stated) : [];
    if (candidates.length !== 1) return null;
    best = candidates[0]!;
  }
  return {
    support: "strong",
    score: best.similarity,
    startChar: best.segment.start,
    endChar: best.segment.end,
    quoteText: input.content.slice(best.segment.start, best.segment.end),
  };
}
