import type { GroundedEvidence } from "@sourceweft/contracts/grounded-evidence";

/**
 * Evidence as a public share may carry it: which source, document and chunk a
 * generated item was cited from, and nothing of the source text itself.
 *
 * A public share page is read by people outside the workspace, and the source
 * library is the workspace's own (the workspace is its sharing boundary), so a
 * shared artifact keeps its generated values and drops the quotes behind them.
 * The quote, its offsets inside the chunk, the quote's digest (a short quote
 * can be recovered from it) and the heading path (source text too) all go.
 *
 * Built field by field, not by deleting the private ones, so a field a producer
 * adds to evidence later stays private until someone decides it may travel.
 * Pure and browser-safe; shared by every grounded artifact type (tables and
 * study artifacts) so they strip the same way.
 */
export type PublicGroundedEvidence = {
  readonly kind: GroundedEvidence["kind"];
  readonly sourceId: string;
  readonly documentId: string;
  readonly chunkId: string;
  readonly chunkNo?: number;
};

export function toPublicGroundedEvidence(
  evidence: GroundedEvidence,
): PublicGroundedEvidence {
  return {
    kind: evidence.kind,
    sourceId: evidence.sourceId,
    documentId: evidence.documentId,
    chunkId: evidence.chunkId,
    ...(typeof evidence.chunkNo === "number" ? { chunkNo: evidence.chunkNo } : {}),
  };
}

export function toPublicGroundedEvidenceList(
  evidence: readonly GroundedEvidence[],
): PublicGroundedEvidence[] {
  return evidence.map(toPublicGroundedEvidence);
}

/**
 * Stands in for evidence a public payload no longer has, so a viewer can parse
 * that payload with the strict content schema (which requires a quote). Only a
 * viewer that never displays evidence may use it.
 */
export const GROUNDED_EVIDENCE_PLACEHOLDER: GroundedEvidence = Object.freeze({
  kind: "chunk",
  sourceId: "-",
  documentId: "-",
  chunkId: "-",
  quote: "-",
  quoteHash: `sha256:${"0".repeat(64)}`,
});
