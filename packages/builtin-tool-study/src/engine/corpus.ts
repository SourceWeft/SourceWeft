import {
  GROUP_MAX_TOKENS,
  GROUP_MIN_TOKENS,
  GROUP_TARGET_TOKENS,
  MAX_TOTAL_INPUT_TOKENS,
} from "./constants";
import type { CorpusChunk, CorpusChunkInput } from "./types";

const CJK_CHAR =
  /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯\u{20000}-\u{2fa1f}]/u;

export function isCjkChar(char: string): boolean {
  return CJK_CHAR.test(char);
}

/**
 * A deliberately conservative token estimate: one token per CJK character,
 * one per four other characters. Pure, so limits are decided the same way
 * everywhere; the gap to real usage is measured by the evaluation runs.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (isCjkChar(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export class StudyInputTooLargeError extends Error {
  readonly totalTokens: number;

  constructor(totalTokens: number) {
    super(
      `The selected sources hold about ${totalTokens} tokens; at most ${MAX_TOTAL_INPUT_TOKENS} can be studied at once`,
    );
    this.name = "StudyInputTooLargeError";
    this.totalTokens = totalTokens;
  }
}

export type AssembledCorpus = {
  chunks: CorpusChunk[];
  totalTokens: number;
};

/**
 * Orders chunks (documents in the order they first appear, chunks by number),
 * gives each a short handle for the prompt, and refuses a selection over
 * `maxTotalTokens` rather than cutting it.
 */
export function assembleCorpus(
  chunks: readonly CorpusChunkInput[],
  options: { maxTotalTokens?: number } = {},
): AssembledCorpus {
  const maxTotalTokens = options.maxTotalTokens ?? MAX_TOTAL_INPUT_TOKENS;
  const documentOrder = new Map<string, number>();
  for (const chunk of chunks) {
    if (!documentOrder.has(chunk.documentId)) {
      documentOrder.set(chunk.documentId, documentOrder.size);
    }
  }
  const ordered = [...chunks].sort(
    (a, b) =>
      documentOrder.get(a.documentId)! - documentOrder.get(b.documentId)! ||
      a.chunkNo - b.chunkNo,
  );
  let totalTokens = 0;
  const result = ordered.map((chunk, index) => {
    const tokens = estimateTokens(chunk.text);
    totalTokens += tokens;
    return { ...chunk, handle: `c${index + 1}`, tokens };
  });
  if (totalTokens > maxTotalTokens) {
    throw new StudyInputTooLargeError(totalTokens);
  }
  return { chunks: result, totalTokens };
}

export type CorpusGroup = {
  index: number;
  chunks: CorpusChunk[];
  tokens: number;
};

/** Close to the target, a heading change is a better cut than a hard limit. */
const HEADING_BREAK_TOKENS = Math.floor(GROUP_TARGET_TOKENS * 0.75);

/**
 * Splits the corpus into groups of about `GROUP_TARGET_TOKENS` for map-reduce.
 * Groups end at document boundaries unless that would leave them too small,
 * prefer heading changes once near the target, and never pass the ceiling
 * (except a single chunk that is larger on its own).
 */
export function groupCorpus(chunks: readonly CorpusChunk[]): CorpusGroup[] {
  const groups: { chunks: CorpusChunk[]; tokens: number }[] = [];
  let current: { chunks: CorpusChunk[]; tokens: number } | null = null;

  for (const chunk of chunks) {
    if (current) {
      const last = current.chunks[current.chunks.length - 1]!;
      const shouldBreak =
        current.tokens + chunk.tokens > GROUP_MAX_TOKENS ||
        current.tokens >= GROUP_TARGET_TOKENS ||
        (last.documentId !== chunk.documentId &&
          current.tokens >= GROUP_MIN_TOKENS) ||
        (last.headingPath !== chunk.headingPath &&
          current.tokens >= HEADING_BREAK_TOKENS);
      if (shouldBreak) {
        groups.push(current);
        current = null;
      }
    }
    current ??= { chunks: [], tokens: 0 };
    current.chunks.push(chunk);
    current.tokens += chunk.tokens;
  }
  if (current) {
    const previous = groups[groups.length - 1];
    if (
      previous &&
      current.tokens < GROUP_MIN_TOKENS &&
      previous.tokens + current.tokens <= GROUP_MAX_TOKENS
    ) {
      previous.chunks.push(...current.chunks);
      previous.tokens += current.tokens;
    } else {
      groups.push(current);
    }
  }
  return groups.map((group, index) => ({ index, ...group }));
}

/**
 * Splits `total` items over groups in proportion to their tokens (largest
 * remainder), with at least one and at most half of the total per group so no
 * group takes over. With more groups than items every group gets one.
 */
export function allocateGroupQuotas(
  total: number,
  groupTokens: readonly number[],
): number[] {
  const count = groupTokens.length;
  if (count === 0) return [];
  if (count >= total) return groupTokens.map(() => 1);

  const ceiling = Math.max(1, Math.ceil(total / 2));
  const sum = groupTokens.reduce((a, b) => a + b, 0);
  const exact = groupTokens.map((tokens) =>
    sum === 0 ? total / count : (total * tokens) / sum,
  );
  const quotas = exact.map((value) =>
    Math.min(ceiling, Math.max(1, Math.floor(value))),
  );

  let assigned = quotas.reduce((a, b) => a + b, 0);
  // Hand out what is left by largest remainder, then take back any excess the
  // one-per-group floor created from the largest quotas.
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  while (assigned < total) {
    let progressed = false;
    for (const { index } of byRemainder) {
      if (assigned >= total) break;
      if (quotas[index]! < ceiling) {
        quotas[index]! += 1;
        assigned += 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  while (assigned > total) {
    let largest = -1;
    for (let index = 0; index < count; index += 1) {
      if (
        quotas[index]! > 1 &&
        (largest < 0 || quotas[index]! > quotas[largest]!)
      ) {
        largest = index;
      }
    }
    if (largest < 0) break;
    quotas[largest]! -= 1;
    assigned -= 1;
  }
  return quotas;
}
