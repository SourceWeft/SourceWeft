import { DEDUPE_JACCARD } from "./constants";

/** Lower case, folded width, no punctuation, symbols or spaces. */
export function normalizeForCompare(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{Z}\s]+/gu, "");
}

function trigrams(text: string): Set<string> {
  const chars = [...normalizeForCompare(text)];
  const grams = new Set<string>();
  if (chars.length < 3) {
    if (chars.length > 0) grams.add(chars.join(""));
    return grams;
  }
  for (let index = 0; index + 3 <= chars.length; index += 1) {
    grams.add(chars.slice(index, index + 3).join(""));
  }
  return grams;
}

/** Jaccard similarity of character 3-grams after normalization. */
export function ngramJaccard(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Lexical near-duplicate removal (no embedding call). Of two duplicates the
 * one with more evidence stays; on a tie the one whose difficulty is rarer
 * among the items kept so far; otherwise the earlier one.
 */
export function dedupeItems<T>(
  items: readonly T[],
  read: {
    text: (item: T) => string;
    evidence: (item: T) => number;
    difficulty: (item: T) => number;
  },
  threshold = DEDUPE_JACCARD,
): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let dropped = 0;
  for (const item of items) {
    const duplicateIndex = kept.findIndex(
      (existing) =>
        ngramJaccard(read.text(existing), read.text(item)) >= threshold,
    );
    if (duplicateIndex < 0) {
      kept.push(item);
      continue;
    }
    dropped += 1;
    const existing = kept[duplicateIndex]!;
    const evidenceGain = read.evidence(item) - read.evidence(existing);
    let replace = evidenceGain > 0;
    if (evidenceGain === 0) {
      const others = kept.filter((_, index) => index !== duplicateIndex);
      const countOf = (difficulty: number) =>
        others.filter((other) => read.difficulty(other) === difficulty).length;
      replace = countOf(read.difficulty(item)) < countOf(read.difficulty(existing));
    }
    if (replace) kept[duplicateIndex] = item;
  }
  return { kept, dropped };
}
