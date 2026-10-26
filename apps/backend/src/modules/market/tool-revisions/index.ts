/**
 * Tool revisions (Issue #367): the history of a catalog listing's tool list,
 * per source. This is the interface the writers use:
 *
 * - `recordToolRevision({ itemId, source, tools, serverVersion?, observedAt? })`
 *   after a SUCCESSFUL, COMPLETE listing — the owner's submission
 *   (`claims/service.ts`), and later the platform snapshot and a member's
 *   authenticated discovery. Never after a failed, partial or unknown one.
 * - `withdrawToolRevision({ itemId, source })` when a source takes its list
 *   back (not the same as an empty list).
 * - `purgeToolRevisions({ itemId, source })` when the history itself must go
 *   (an admin block).
 * - Pass `{ tx }` to commit with the caller's own write.
 *
 * Writers that can observe the same list out of order (a member's discovery,
 * a platform snapshot run) must give `observedAt` an ordering rule of their
 * own: a slow older observation arriving after a newer one is compared with
 * the NEWER revision and would be recorded as a change back. This module
 * orders by call, not by `observedAt`.
 */
export {
  isToolSourceTakenDown,
  purgeToolRevisions,
  recordToolRevision,
  restoreToolSource,
  takedownToolSource,
  withdrawToolRevision,
  type RecordToolRevisionInput,
  type ToolRevisionOutcome,
  type ToolRevisionTx,
  type WithdrawToolRevisionInput,
  type WithdrawToolRevisionOutcome,
} from "./record";
export {
  TOOL_CANONICAL_VERSION,
  TOOL_REVISIONS_KEPT_FULL,
  TOOL_REVISIONS_KEPT_ROWS,
  TOOL_REVISIONS_PER_DAY,
  ToolRevisionInputError,
  type ToolRevisionDiff,
} from "./canonical";
export {
  applyReferenceToolsToManifest,
  baseToolsOf,
  readReferenceTools,
  readToolRevisionsPage,
  readToolsRevision,
  referenceIsStale,
  type BaseTools,
  type ReferenceTools,
} from "./read";
