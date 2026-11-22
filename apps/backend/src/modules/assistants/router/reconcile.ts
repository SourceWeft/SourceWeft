/**
 * Decision completeness: once a Router run reaches a terminal state, every
 * event its batch claimed must end up either `decided` or back on the
 * queue — never silently stuck `in_eval` forever. Task 7 detects the
 * terminal state (the same way it detects any host-started run finishing)
 * and calls `reconcileRouterRun`; this module does not watch runs itself.
 */
import { db } from "@sourceweft/db";
import { ASSISTANT_LIMITS } from "../limits";
import { assistantPorts, type AssistantPorts } from "../ports";
import {
  findAssistantRow,
  requeueOrExpireInEvalTriggerRows,
  updateAssistantRow,
  type AssistantRow,
} from "../repository";

export type ReconcileRouterRunResult = {
  requeued: number;
  unavailable: number;
};

/**
 * Sweeps up anything `assistant.current_router_run_id`'s batch left
 * `in_eval` (never resolved with `create_ticket`/`route_to_ticket`/`ignore`)
 * and clears the assistant's current-run bookkeeping so the next cycle can
 * start a fresh one.
 *
 * Each leftover trigger's `eval_attempts` goes up by one; once it reaches
 * `evalMaxAttempts` it becomes `unavailable` instead of going back to
 * `pending_eval` (Review Focus 2: it must never just vanish). Any triggers
 * that became `unavailable` this call produce exactly one
 * `assistant_unavailable` notification to the steward, not one per trigger.
 *
 * A stale or duplicate call — the assistant has since moved on to a
 * different run — is a no-op. The check is against a *fresh*, `for update`
 * read of the assistant row taken inside this call's own transaction, not
 * against the `assistant` snapshot the caller passed in: a delayed or
 * duplicate reconcile for an old run, called after a newer run has already
 * started (and written its own `current_router_run_id`/
 * `current_router_batch_key`), must never clear that newer run's
 * bookkeeping just because the caller's snapshot still shows the old one.
 * `FOR UPDATE` also serializes a genuine race between two reconcile calls
 * for the *same* run key.
 */
export async function reconcileRouterRun(
  assistant: AssistantRow,
  run: { id: string },
  ports: AssistantPorts = assistantPorts,
): Promise<ReconcileRouterRunResult> {
  const now = new Date();

  const leftover = await db.transaction(async (tx) => {
    const current = await findAssistantRow(
      { workspaceId: assistant.workspaceId, teamId: assistant.teamId },
      tx,
      { forUpdate: true },
    );
    if (!current || current.currentRouterRunId !== run.id) {
      // Stale/duplicate: this run is no longer (or never was) the one in
      // flight. Touch nothing.
      return null;
    }
    const batchKey = current.currentRouterBatchKey;
    const rows = batchKey
      ? await requeueOrExpireInEvalTriggerRows(tx, {
          assistantId: current.id,
          teamId: current.teamId,
          workspaceId: current.workspaceId,
          routerBatchKey: batchKey,
          evalMaxAttempts: ASSISTANT_LIMITS.evalMaxAttempts,
        })
      : [];
    await updateAssistantRow(tx, current.id, {
      currentRouterRunId: null,
      currentRouterBatchKey: null,
      updatedAt: now,
    });
    return rows;
  });

  if (leftover === null) {
    return { requeued: 0, unavailable: 0 };
  }

  const unavailable = leftover.filter((row) => row.status === "unavailable");
  const requeued = leftover.filter((row) => row.status === "pending_eval");

  if (unavailable.length > 0) {
    await ports.notify({
      kind: "assistant_unavailable",
      teamId: assistant.teamId,
      userId: assistant.stewardUserId,
      email: true,
      ref: { kind: "assistant", id: assistant.id },
      payload: {
        assistantId: assistant.id,
        unavailableCount: unavailable.length,
      },
    });
  }

  return { requeued: requeued.length, unavailable: unavailable.length };
}
