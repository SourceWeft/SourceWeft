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

export class InputTooLargeError extends Error {
  readonly totalTokens: number;

  constructor(totalTokens: number) {
    super(
      `The selected sources hold about ${totalTokens} tokens; at most ${MAX_TOTAL_INPUT_TOKENS} can be studied at once`,
    );
    this.name = "InputTooLargeError";
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
    throw new InputTooLargeError(totalTokens);
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
