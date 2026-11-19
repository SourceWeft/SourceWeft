import type { GroundedEvidence } from "@sourceweft/contracts/grounded-evidence";
import { TABLE_LIMITS, type TableColumnType } from "@sourceweft/contracts/table";
import { normalizedValue, valueKey } from "./normalize";

/** A candidate value that passed anchoring and its type rule. */
export type VerifiedCandidate = {
  value: string;
  evidence: GroundedEvidence[];
};

/** What a column of one source resolved to, before it becomes a cell. */
export type ColumnOutcome =
  | { status: "not_found" }
  | { status: "unverified" }
  | {
      status: "found";
      value: string;
      normalized?: number | string | boolean;
      evidence: GroundedEvidence[];
    };

/**
 * Groups candidates that state the same value, however it is written
 * (`1,200` and `1.2k`; `March 5, 2024` and `2024-03-05`), in the order they
 * first appear.
 */
export function bucketCandidates(
  type: TableColumnType,
  candidates: readonly VerifiedCandidate[],
): VerifiedCandidate[][] {
  const buckets = new Map<string, VerifiedCandidate[]>();
  for (const candidate of candidates) {
    const key = valueKey(type, candidate.value);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(candidate);
    else buckets.set(key, [candidate]);
  }
  return [...buckets.values()];
}

/** The candidates agree: the first value, with their evidence (at most two entries). */
function agreed(
  type: TableColumnType,
  bucket: readonly VerifiedCandidate[],
): ColumnOutcome {
  const value = bucket[0]!.value;
  const evidence: GroundedEvidence[] = [];
  const seen = new Set<string>();
  for (const entry of bucket.flatMap((candidate) => candidate.evidence)) {
    const key = `${entry.chunkId}:${entry.startChar ?? ""}:${entry.endChar ?? ""}`;
    if (seen.has(key) || evidence.length >= TABLE_LIMITS.evidencePerCell) continue;
    seen.add(key);
    evidence.push(entry);
  }
  const normalized = normalizedValue(type, value);
  return {
    status: "found",
    value,
    ...(normalized === undefined ? {} : { normalized }),
    evidence,
  };
}

/**
 * One column of one source, from what its groups claimed.
 *
 * - nothing was claimed: `not_found`;
 * - something was claimed but nothing verified: `unverified`;
 * - the verified candidates all state the same value: their evidence is merged
 *   without a model call;
 * - they differ: `choose` (one model call, given the candidate values and their
 *   anchored passages) picks one; an answer that points at no candidate leaves
 *   the cell `unverified`.
 */
export async function resolveColumn(input: {
  type: TableColumnType;
  claimed: boolean;
  verified: readonly VerifiedCandidate[];
  choose(candidates: readonly VerifiedCandidate[]): Promise<number | null>;
}): Promise<ColumnOutcome> {
  if (!input.claimed) return { status: "not_found" };
  if (input.verified.length === 0) return { status: "unverified" };
  const buckets = bucketCandidates(input.type, input.verified);
  if (buckets.length === 1) return agreed(input.type, buckets[0]!);
  const picked = await input.choose(buckets.map((bucket) => bucket[0]!));
  const bucket = picked === null ? undefined : buckets[picked];
  return bucket ? agreed(input.type, bucket) : { status: "unverified" };
}
