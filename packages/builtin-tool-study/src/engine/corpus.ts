/**
 * Corpus assembly, grouping and token estimation live in the shared grounded
 * generation package; they are re-exported here under the names the study
 * engine has always used. Only the study-specific item allocation stays.
 */
import type { CorpusGroup } from "@sourceweft/grounded-generation";

export {
  assembleCorpus,
  estimateTokens,
  groupCorpus,
  InputTooLargeError as StudyInputTooLargeError,
  isCjkChar,
  type AssembledCorpus,
  type CorpusGroup,
} from "@sourceweft/grounded-generation";

/**
 * Splits `total` items over groups in proportion to their tokens (largest
 * remainder), with at least one per group and, when there are several, at most
 * half of the total per group so no group takes over. A single group gets the
 * whole total. With more groups than items every group gets one.
 */
export function allocateGroupQuotas(
  total: number,
  groupTokens: readonly number[],
): number[] {
  const count = groupTokens.length;
  if (count === 0) return [];
  if (count >= total) return groupTokens.map(() => 1);

  const ceiling = count === 1 ? total : Math.max(1, Math.ceil(total / 2));
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

/**
 * Splits chunks into `parts` consecutive runs of about equal tokens, each
 * holding at least one chunk (fewer runs when there are fewer chunks).
 */
export function splitChunks<T extends { tokens: number }>(
  chunks: readonly T[],
  parts: number,
): T[][] {
  const runsWanted = Math.max(1, Math.min(parts, chunks.length));
  const total = chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);
  const runs: T[][] = [];
  let current: T[] = [];
  let tokens = 0;
  chunks.forEach((chunk, index) => {
    current.push(chunk);
    tokens += chunk.tokens;
    const closed = runs.length;
    if (closed >= runsWanted - 1) return;
    const chunksLeft = chunks.length - index - 1;
    const runsLeftAfter = runsWanted - closed - 1;
    if (tokens >= (total * (closed + 1)) / runsWanted || chunksLeft === runsLeftAfter) {
      runs.push(current);
      current = [];
    }
  });
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * Groups whose share is more than one call should write are split into
 * consecutive runs of their chunks, each with its own share, so no single
 * answer grows past what a call returns in time. Indices are renumbered.
 */
export function splitForCallSize(
  groups: readonly CorpusGroup[],
  quotas: readonly number[],
  maxPerCall: number,
): { groups: CorpusGroup[]; quotas: number[] } {
  const split: { chunks: CorpusGroup["chunks"]; quota: number }[] = [];
  groups.forEach((group, position) => {
    const quota = quotas[position]!;
    const parts = Math.min(Math.ceil(quota / maxPerCall), group.chunks.length);
    if (parts <= 1) {
      split.push({ chunks: group.chunks, quota });
      return;
    }
    const runs = splitChunks(group.chunks, parts);
    const shares = allocateGroupQuotas(
      quota,
      runs.map((run) => run.reduce((sum, chunk) => sum + chunk.tokens, 0)),
    );
    runs.forEach((run, index) => split.push({ chunks: run, quota: shares[index]! }));
  });
  return {
    groups: split.map(({ chunks }, index) => ({
      index,
      chunks,
      tokens: chunks.reduce((sum, chunk) => sum + chunk.tokens, 0),
    })),
    quotas: split.map(({ quota }) => quota),
  };
}
