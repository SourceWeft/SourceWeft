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
 * - Pass `{ tx }` to commit with the caller's own write.
 */
export {
  recordToolRevision,
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
  ToolRevisionInputError,
  type ToolRevisionDiff,
} from "./canonical";
export { readToolRevisionsPage, readToolsRevision } from "./read";
