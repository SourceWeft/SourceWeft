import { figuresCovered } from "./figures";
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
  const best = ranked[0]!;
  const margin =
    ranked.length > 1 ? best.similarity - ranked[1]!.similarity : Infinity;
  if (
    best.similarity < SEMANTIC_MIN_SIMILARITY ||
    margin < SEMANTIC_MIN_MARGIN ||
    !figuresCovered(input.claim, best.segment.text)
  ) {
    return null;
  }
  return {
    support: "strong",
    score: best.similarity,
    startChar: best.segment.start,
    endChar: best.segment.end,
    quoteText: input.content.slice(best.segment.start, best.segment.end),
  };
}
