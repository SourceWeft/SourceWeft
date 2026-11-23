/**
 * Which pending events the Router looks at next, and claiming them so a
 * concurrent cycle cannot pick the same ones up twice.
 *
 * `selectNextBatch` is a pure function over rows the caller already loaded
 * (Task 7's scheduler tick): no DB access, so it is tested directly with
 * constructed rows. `claimBatch` is the one DB-touching piece here, and it
 * only ever flips `pending_eval` → `in_eval` (see
 * `repository.ts#claimTriggerRows`) — a CAS, not a plain update, so a second
 * caller racing the same cycle claims nothing already taken.
 */
import { db } from "@sourceweft/db";
import type { AssistantTriggerSource } from "@sourceweft/contracts/assistants";
import { deterministicId } from "../../agent-tasks/runs";
import { ASSISTANT_LIMITS } from "../limits";
import { claimTriggerRows, type Executor } from "../repository";

/**
 * The one shape `selectNextBatch` needs from a pending trigger row. Built
 * from `assistant_triggers` rows already filtered to `status = 'pending_eval'`
 * by the caller — this function does not re-check status, only groups and
 * orders what it is given.
 */
export type PendingTrigger = {
  id: string;
  payerUserId: string;
  sourceKind: AssistantTriggerSource;
  createdAt: Date;
};

export type RouterBatch = { payerUserId: string; triggerIds: string[] };

/**
 * Picks the next batch to hand the Router, or `null` when there is nothing
 * pending (after `excludePayers` is applied).
 *
 * Pending events group by `payerUserId`; one payer's events never mix with
 * another's in the same batch (a blocked or quota-exhausted payer's batch
 * must never stall somebody else's). Groups are ordered: a group holding at
 * least one `member_message` always goes before one with none (a member
 * waiting on a reply outranks a worker's own report), and within the same
 * tier the group whose earliest event is oldest goes first (FIFO). The
 * chosen group's events are then sorted oldest-first and capped at
 * `routerBatchMax`.
 */
export function selectNextBatch(
  rows: readonly PendingTrigger[],
  excludePayers: ReadonlySet<string> = new Set(),
): RouterBatch | null {
  const groups = new Map<string, PendingTrigger[]>();
  for (const row of rows) {
    if (excludePayers.has(row.payerUserId)) continue;
    const list = groups.get(row.payerUserId);
    if (list) list.push(row);
    else groups.set(row.payerUserId, [row]);
  }

  let best: {
    payerUserId: string;
    sorted: PendingTrigger[];
    hasMember: boolean;
    earliest: number;
  } | null = null;

  for (const [payerUserId, groupRows] of groups) {
    const sorted = [...groupRows].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const hasMember = sorted.some((row) => row.sourceKind === "member_message");
    const earliest = sorted[0]!.createdAt.getTime();
    const better =
      !best ||
      (hasMember && !best.hasMember) ||
      (hasMember === best.hasMember && earliest < best.earliest);
    if (better) best = { payerUserId, sorted, hasMember, earliest };
  }

  if (!best) return null;
  return {
    payerUserId: best.payerUserId,
    triggerIds: best.sorted
      .slice(0, ASSISTANT_LIMITS.routerBatchMax)
      .map((row) => row.id),
  };
}

/**
 * The batch's own deterministic key, independent of the order `triggerIds`
 * were supplied in (the ids are sorted before hashing) — the Router's own
 * decisions and `assistants.current_router_batch_key` are keyed by this.
 */
export function routerBatchKey(triggerIds: readonly string[]): string {
  return deterministicId("assistant-router-batch", ...[...triggerIds].sort());
}

/**
 * Claims a batch's triggers (CAS: see `claimTriggerRows`), returning only
 * the ids that were actually claimed — fewer than `batch.triggerIds` means
 * a concurrent cycle got to some of them first, which the caller (Task 7)
 * decides how to handle (most simply: proceed with whatever was claimed).
 *
 * `tenant` is the assistant's own team/workspace (every query carries both,
 * per the global tenant-isolation constraint) — not part of the brief's
 * `claimBatch(assistantId, batch, batchKey)` signature verbatim, added here
 * because `assistantId` alone is not enough to satisfy that constraint at
 * the query layer.
 */
export async function claimBatch(
  assistantId: string,
  batch: RouterBatch,
  batchKey: string,
  tenant: { teamId: string; workspaceId: string },
  executor: Executor = db,
): Promise<{ claimedTriggerIds: string[] }> {
  const claimed = await claimTriggerRows(executor, {
    assistantId,
    teamId: tenant.teamId,
    workspaceId: tenant.workspaceId,
    triggerIds: batch.triggerIds,
    batchKey,
  });
  return { claimedTriggerIds: claimed.map((row) => row.id) };
}
