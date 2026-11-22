/**
 * Corpus assembly, grouping and token estimation live in the shared grounded
 * generation package; they are re-exported here under the names the study
 * engine has always used. Only the study-specific item allocation stays.
 */
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
