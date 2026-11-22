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
 * different run — is a no-op: `run.id` is checked against
 * `assistant.current_router_run_id` before anything is touched, so calling
 * this twice for the same run is also safe (the second call's batch key is
 * already cleared, so it finds nothing left `in_eval` under it... unless a
 * *new* run has since reused `current_router_run_id`, which the `run.id`
 * check also catches).
 */
export async function reconcileRouterRun(
  assistant: AssistantRow,
  run: { id: string },
  ports: AssistantPorts = assistantPorts,
): Promise<ReconcileRouterRunResult> {
  if (assistant.currentRouterRunId !== run.id) {
    return { requeued: 0, unavailable: 0 };
  }

  const batchKey = assistant.currentRouterBatchKey;
  const now = new Date();

  const leftover = await db.transaction(async (tx) => {
    const rows = batchKey
      ? await requeueOrExpireInEvalTriggerRows(tx, {
          assistantId: assistant.id,
          routerBatchKey: batchKey,
          evalMaxAttempts: ASSISTANT_LIMITS.evalMaxAttempts,
        })
      : [];
    await updateAssistantRow(tx, assistant.id, {
      currentRouterRunId: null,
      currentRouterBatchKey: null,
      updatedAt: now,
    });
    return rows;
  });

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
