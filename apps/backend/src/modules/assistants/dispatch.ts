/**
 * What keeps a workspace assistant moving: the scheduler's tick
 * (`runAssistantTick`) and the immediate kick after a member's message
 * (`kickAssistant`).
 *
 * Each tick walks every active assistant, one at a time, each with its own
 * error boundary (one assistant failing is logged and the tick moves on).
 * Ticks never overlap: they run in the single scheduler process, guarded by
 * an in-process flag. A kick only ever does step 5, which is safe to race
 * with a tick: claiming a batch is a compare-and-set, the Router's run is
 * recorded only over an empty slot (or the same run), and the Router
 * conversation takes one run at a time (a second start is a 409). Steps 2-4
 * re-read the rows they change `for update`. For one assistant, in order:
 *
 *   1. Steward check: a steward who can no longer reach the workspace pauses
 *      the assistant (`steward_left`); nothing else happens, and runs already
 *      going are left to finish (Review Focus 4).
 *   2. Settle the Router's run once it has ended (`reconcileRouterRun`).
 *   3. Settle each ticket's worker run once it has ended; stop one that ran
 *      past `workerRunTimeoutMs`.
 *   4. Start worker runs for tickets with something to work on, within the
 *      worker slots (plus the one slot reserved for a member's input).
 *   5. Start the Router on the next batch of events when it is idle.
 *
 * Every write that decides something happens in a short transaction of its
 * own; notifications are sent after the write commits and a notification
 * failure is logged, never allowed to undo or stop anything.
 */
import { db } from "@sourceweft/db";
import type { TicketBlockedReason } from "@sourceweft/contracts/assistants";
import { deterministicId } from "../agent-tasks/runs";
import { isContentError } from "../content/errors";
import { RUN_CREDIT_CAP_EXCEEDED } from "../threads/agent/middleware/run-credit-cap";
import type { BillingAdmissionError } from "../../shared/model-gateway/billing/admission";
import { logger } from "../../shared/logger";
import { ASSISTANT_LIMITS } from "./limits";
import { assistantPorts, type AssistantPorts } from "./ports";
import {
  chatRunExistsForKey,
  countWorkingTicketRows,
  findAssistantRowById,
  findChatRunRow,
  findScopedTicketRow,
  findThreadVisibility,
  findTriggerRowsByIds,
  insertTriggerRow,
  listActiveAssistantRows,
  listAllInEvalTriggerRows,
  listDispatchableTicketRows,
  listPendingEvalTriggerRows,
  listRouteNotes,
  listTicketRowsWithRun,
  listUndeliveredRoutedTriggerRows,
  markTriggersDeliveredRows,
  recordRouterRunRow,
  releaseInEvalTriggerRows,
  requeueOrExpireInEvalTriggerRows,
  sumThreadRunCredits,
  ticketHasDeliveredTrigger,
  updateAssistantRow,
  updateScopedTicketRow,
  type AssistantRow,
  type AssistantScope,
  type AssistantTicketRow,
  type AssistantTriggerRow,
} from "./repository";
import {
  claimBatch,
  routerBatchKey,
  selectNextBatch,
  type PendingTrigger,
  type RouterBatch,
} from "./router/batch";
import { reconcileRouterRun } from "./router/reconcile";
import { fetchRouterBatchContext, renderBatch, type RenderTrigger } from "./router/render";
import { ASSISTANT_TICKET_REF } from "./worker/tools";
import { renderWorkerDelivery, type WorkerDeliveryKind } from "./worker/render";

/** A run in one of these will not change any more. */
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

/** `chat_thread_runs.error_code` of a run refused for the payer's credits:
 * the code `BillingAdmissionError` carries (typed against it, so the two
 * cannot drift apart). */
const BILLING_ADMISSION_DENIED: BillingAdmissionError["code"] =
  "BILLING_ADMISSION_DENIED";

/** What `startHostTurn` refuses with when the conversation already has an
 * active run (`threads/durable/service.ts`). */
const CHAT_RUN_ALREADY_ACTIVE = "CHAT_RUN_ALREADY_ACTIVE";

/** The Router conversation already exists; its title is left as is. */
const ROUTER_THREAD_TITLE = "Workspace assistant";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function scopeOf(assistant: AssistantRow): AssistantScope {
  return {
    assistantId: assistant.id,
    teamId: assistant.teamId,
    workspaceId: assistant.workspaceId,
  };
}

/**
 * `ports` with `notify` made safe to call after a commit: a failure is
 * logged with what it was about and swallowed, so the write that already
 * happened stands and the tick goes on. Every notification in this module
 * (and in `reconcileRouterRun`, which it calls) goes through this.
 */
function withLoggedNotify(ports: AssistantPorts): AssistantPorts {
  return {
    ...ports,
    async notify(input) {
      try {
        return await ports.notify(input);
      } catch (error) {
        logger.error("Assistant notification failed", {
          kind: input.kind,
          userId: input.userId,
          ref: input.ref,
          error: errorMessage(error),
        });
        return null;
      }
    },
  };
}

// ── 1. Steward check ────────────────────────────────────────────────────

async function pauseForStewardLeft(
  assistant: AssistantRow,
  now: Date,
  ports: AssistantPorts,
): Promise<void> {
  const paused = await db.transaction(async (tx) => {
    const current = await findAssistantRowById(
      { id: assistant.id, teamId: assistant.teamId, workspaceId: assistant.workspaceId },
      tx,
      { forUpdate: true },
    );
    if (!current || current.status !== "active") return null;
    return updateAssistantRow(tx, current.id, {
      status: "paused",
      statusReason: "steward_left",
      version: current.version + 1,
      updatedAt: now,
    });
  });
  if (!paused) return;
  logger.warn("Assistant paused: its steward can no longer reach the workspace", {
    assistantId: assistant.id,
    stewardUserId: assistant.stewardUserId,
  });
  try {
    await ports.audit({
      teamId: assistant.teamId,
      actorUserId: null,
      action: "assistant.paused",
      targetType: "assistant",
      targetId: assistant.id,
      metadata: { reason: "steward_left", stewardUserId: assistant.stewardUserId },
    });
  } catch (error) {
    logger.error("Failed to audit an assistant pause", {
      assistantId: assistant.id,
      error: errorMessage(error),
    });
  }
}

// ── 2. The Router's run ─────────────────────────────────────────────────

/** Reconciles the Router's run once it has ended (or is gone). Also covers
 * a run that ended before its id was written: the id is written right after
 * the start, and this sees a run already terminal. */
async function settleRouterRun(
  assistant: AssistantRow,
  ports: AssistantPorts,
): Promise<void> {
  if (!assistant.currentRouterRunId) return;
  const run = await findChatRunRow({
    runId: assistant.currentRouterRunId,
    teamId: assistant.teamId,
    workspaceId: assistant.workspaceId,
  });
  if (run && !TERMINAL_RUN_STATUSES.has(run.status)) return;
  if (!run) {
    logger.warn("Assistant Router run is missing; reconciling it as ended", {
      assistantId: assistant.id,
      runId: assistant.currentRouterRunId,
    });
  }
  const result = await reconcileRouterRun(
    assistant,
    { id: assistant.currentRouterRunId },
    ports,
  );
  if (result.requeued > 0 || result.unavailable > 0) {
    logger.warn("Assistant Router run ended with events left undecided", {
      assistantId: assistant.id,
      runId: assistant.currentRouterRunId,
      ...result,
    });
  }
}

// ── 3. Worker runs ──────────────────────────────────────────────────────

/** A blocked ticket's columns: waiting for a person, `outcome = blocked`,
 * and why. The caller notifies the payer (`notifyBlocked`) after commit. */
function blockedValues(reason: TicketBlockedReason, now: Date) {
  return {
    stage: "waiting_person" as const,
    outcome: "blocked" as const,
    blockedReason: reason,
    updatedAt: now,
  };
}

async function notifyBlocked(
  ports: AssistantPorts,
  assistant: AssistantRow,
  ticket: AssistantTicketRow,
  reason: TicketBlockedReason,
) {
  logger.warn("Assistant ticket blocked", {
    assistantId: assistant.id,
    ticketId: ticket.id,
    reason,
  });
  await ports.notify({
    kind: "assistant_ticket_blocked",
    teamId: assistant.teamId,
    userId: ticket.payerUserId,
    ref: { kind: ASSISTANT_TICKET_REF, id: ticket.id },
    payload: {
      assistantId: assistant.id,
      ticketId: ticket.id,
      taskName: ticket.title,
      reason,
    },
  });
}

/**
 * Settles one ticket whose `current_run_id` names a run. A run still going
 * is only checked against its time limit (and stopped past it; the stop
 * ends it, and a later tick settles it). An ended run is settled exactly
 * once — the ticket is re-read `for update` and left alone if its
 * `current_run_id` already moved on:
 *
 * - completed, ticket still `working` (the worker never called `report`):
 *   `waiting_person`, plus an `ended_without_report` worker_report event;
 * - failed with `RUN_CREDIT_CAP_EXCEEDED`: blocked on `credit_cap`;
 * - failed with the billing admission code: blocked on `insufficient_credits`;
 * - any other failure, a cancelled run, or a run that is gone, while the
 *   payer has no credits left: blocked on `insufficient_credits`, with no
 *   failure counted. A run refused for credits mid-turn is stored with a
 *   generic error code (the turn's error mapping does not keep the billing
 *   admission code), so the payer's credits are checked here instead;
 * - any other failure, a cancelled run, or a run that is gone: one more
 *   consecutive failure; at `consecutiveFailuresToBlock` blocked on
 *   `repeated_failure`, below it back to `queued` for another try.
 *
 * The failure rules apply only while the ticket is still `working`: a
 * ticket the worker already reported on (or a member closed) keeps what it
 * says, and only its run is cleared. `current_run_id` is cleared in every
 * case. A completed run resets the failure count.
 */
async function settleWorkerRun(
  assistant: AssistantRow,
  ticket: AssistantTicketRow,
  now: Date,
  ports: AssistantPorts,
): Promise<void> {
  const runId = ticket.currentRunId!;
  const scope = { ...scopeOf(assistant), ticketId: ticket.id };
  const run = await findChatRunRow({
    runId,
    teamId: assistant.teamId,
    workspaceId: assistant.workspaceId,
  });

  if (run && !TERMINAL_RUN_STATUSES.has(run.status)) {
    const startedAt = run.startedAt ?? run.createdAt;
    if (now.getTime() - startedAt.getTime() > ASSISTANT_LIMITS.workerRunTimeoutMs) {
      logger.warn("Assistant worker run ran past its time limit; stopping it", {
        assistantId: assistant.id,
        ticketId: ticket.id,
        runId,
      });
      await ports.stopRun({
        workspaceId: assistant.workspaceId,
        threadId: ticket.workerThreadId,
        runId,
        userId: run.userId,
      });
    }
    return;
  }
  if (!run) {
    logger.warn("Assistant worker run is missing; settling it as failed", {
      assistantId: assistant.id,
      ticketId: ticket.id,
      runId,
    });
  }

  // Checked before the transaction (it is a call to billing, not a row of
  // ours), and only when the run ended in an ordinary failure.
  const genericFailure =
    run?.status !== "completed" &&
    !(
      run?.status === "failed" &&
      (run.errorCode === RUN_CREDIT_CAP_EXCEEDED ||
        run.errorCode === BILLING_ADMISSION_DENIED)
    );
  const payerOutOfCredits =
    genericFailure &&
    ticket.stage === "working" &&
    !(await ports.hasCredits({
      teamId: assistant.teamId,
      userId: ticket.payerUserId,
    }));

  const blocked = await db.transaction(async (tx) => {
    const current = await findScopedTicketRow(scope, tx, { forUpdate: true });
    if (!current || current.currentRunId !== runId) return null;

    const clear = { currentRunId: null, updatedAt: now };
    if (current.stage !== "working") {
      await updateScopedTicketRow(tx, scope, {
        ...clear,
        ...(run?.status === "completed" ? { consecutiveFailures: 0 } : {}),
      });
      return null;
    }

    if (run?.status === "completed") {
      const triggerId = deterministicId(
        "assistant-worker-report",
        current.id,
        runId,
        "ended_without_report",
      );
      await insertTriggerRow(tx, {
        id: triggerId,
        teamId: current.teamId,
        workspaceId: current.workspaceId,
        assistantId: current.assistantId,
        sourceKind: "worker_report",
        payerUserId: current.payerUserId,
        authorUserId: null,
        dedupeKey: triggerId,
        text: "ended_without_report",
        ticketId: current.id,
        status: "pending_eval",
      });
      await updateScopedTicketRow(tx, scope, {
        ...clear,
        stage: "waiting_person",
        consecutiveFailures: 0,
      });
      return null;
    }

    let reason: TicketBlockedReason | null = null;
    if (run?.status === "failed" && run.errorCode === RUN_CREDIT_CAP_EXCEEDED) {
      reason = "credit_cap";
    } else if (
      run?.status === "failed" &&
      run.errorCode === BILLING_ADMISSION_DENIED
    ) {
      reason = "insufficient_credits";
    } else if (payerOutOfCredits) {
      reason = "insufficient_credits";
    }
    if (reason) {
      await updateScopedTicketRow(tx, scope, {
        ...clear,
        ...blockedValues(reason, now),
      });
      return { ticket: current, reason };
    }

    const failures = current.consecutiveFailures + 1;
    logger.warn("Assistant worker run failed", {
      assistantId: assistant.id,
      ticketId: current.id,
      runId,
      status: run?.status ?? "missing",
      errorCode: run?.errorCode ?? null,
      consecutiveFailures: failures,
    });
    if (failures >= ASSISTANT_LIMITS.consecutiveFailuresToBlock) {
      await updateScopedTicketRow(tx, scope, {
        ...clear,
        ...blockedValues("repeated_failure", now),
        consecutiveFailures: failures,
      });
      return { ticket: current, reason: "repeated_failure" as const };
    }
    await updateScopedTicketRow(tx, scope, {
      ...clear,
      stage: "queued",
      consecutiveFailures: failures,
    });
    return null;
  });

  if (blocked) {
    await notifyBlocked(ports, assistant, blocked.ticket, blocked.reason);
  }
}

async function settleWorkerRuns(
  assistant: AssistantRow,
  now: Date,
  ports: AssistantPorts,
): Promise<void> {
  const tickets = await listTicketRowsWithRun(scopeOf(assistant));
  for (const ticket of tickets) {
    try {
      await settleWorkerRun(assistant, ticket, now, ports);
    } catch (error) {
      logger.error("Failed to settle an assistant worker run", {
        assistantId: assistant.id,
        ticketId: ticket.id,
        runId: ticket.currentRunId,
        error: errorMessage(error),
      });
    }
  }
}

// ── 4. Worker dispatch ──────────────────────────────────────────────────

type DispatchCandidate = {
  ticket: AssistantTicketRow;
  /** Undelivered events routed to it, oldest first. */
  triggers: AssistantTriggerRow[];
  earliest: number;
  hasMemberInput: boolean;
};

function toRenderTrigger(row: AssistantTriggerRow): RenderTrigger {
  return {
    id: row.id,
    source: row.sourceKind,
    author: row.authorUserId ?? null,
    text: row.text,
    ticketId: row.ticketId ?? null,
  };
}

/**
 * Tickets that may get a worker run now, oldest event first: a `queued`
 * ticket, or one (neither working nor ended) with events routed to it that
 * no run has been given. A ticket whose last run is not settled yet waits
 * for step 3.
 */
async function listDispatchCandidates(
  scope: AssistantScope,
): Promise<DispatchCandidate[]> {
  const [tickets, undelivered] = await Promise.all([
    listDispatchableTicketRows(scope),
    listUndeliveredRoutedTriggerRows(scope),
  ]);
  const byTicket = new Map<string, AssistantTriggerRow[]>();
  for (const row of undelivered) {
    const list = byTicket.get(row.routedTicketId!);
    if (list) list.push(row);
    else byTicket.set(row.routedTicketId!, [row]);
  }
  return tickets
    .filter(
      (ticket) =>
        !ticket.currentRunId &&
        (ticket.stage === "queued" || byTicket.has(ticket.id)),
    )
    .map((ticket) => {
      const triggers = byTicket.get(ticket.id) ?? [];
      return {
        ticket,
        triggers,
        earliest: (triggers[0]?.createdAt ?? ticket.createdAt).getTime(),
        hasMemberInput: triggers.some(
          (row) => row.sourceKind === "member_message",
        ),
      };
    })
    .sort(
      (a, b) =>
        a.earliest - b.earliest || a.ticket.id.localeCompare(b.ticket.id),
    );
}

/**
 * What this run is and its idempotency key: the ticket's first run
 * (`initial`), new events for a ticket that ran before (the sorted ids of
 * exactly the events delivered), or another try after a failed run with
 * nothing new. A retry's key names the failure count and the moment that
 * failure was settled, so it never reuses an earlier run's key, and stays
 * the same if this same dispatch is repeated.
 */
async function deliveryFor(
  scope: AssistantScope,
  candidate: DispatchCandidate,
): Promise<{ kind: WorkerDeliveryKind; keyParts: string[] }> {
  const { ticket, triggers } = candidate;
  const everDelivered = await ticketHasDeliveredTrigger({
    ...scope,
    ticketId: ticket.id,
  });
  if (!everDelivered) return { kind: "initial", keyParts: ["initial"] };
  if (triggers.length > 0) {
    return {
      kind: "append",
      keyParts: [triggers.map((row) => row.id).sort().join(",")],
    };
  }
  return {
    kind: "retry",
    keyParts: [
      "retry",
      String(ticket.consecutiveFailures),
      ticket.updatedAt.toISOString(),
    ],
  };
}

type DispatchOutcome = "started" | "blocked" | "skipped";

async function dispatchTicket(
  assistant: AssistantRow,
  candidate: DispatchCandidate,
  visibility: "private" | "workspace",
  now: Date,
  ports: AssistantPorts,
): Promise<DispatchOutcome> {
  const { ticket, triggers } = candidate;
  const scope = scopeOf(assistant);
  const ticketScope = { ...scope, ticketId: ticket.id };

  // No credits: blocked and the payer told, without taking a slot — and
  // without holding up anyone else's ticket (Review Focus 3). Told once:
  // a ticket already blocked for this is left as it is.
  const hasCredits = await ports.hasCredits({
    teamId: assistant.teamId,
    userId: ticket.payerUserId,
  });
  if (!hasCredits) {
    if (ticket.outcome === "blocked" && ticket.blockedReason === "insufficient_credits") {
      return "blocked";
    }
    const changed = await db.transaction(async (tx) => {
      const current = await findScopedTicketRow(ticketScope, tx, { forUpdate: true });
      if (!current || current.stage === "working" || current.stage === "ended") {
        return false;
      }
      await updateScopedTicketRow(tx, ticketScope, blockedValues("insufficient_credits", now));
      return true;
    });
    if (changed) await notifyBlocked(ports, assistant, ticket, "insufficient_credits");
    return "blocked";
  }

  // The cap is the whole ticket's, not each run's: a run gets only what its
  // earlier runs left. Nothing left blocks the ticket on `credit_cap`, the
  // same state a run stopped at its cap leaves — told once, like above.
  const spent = await sumThreadRunCredits({
    threadId: ticket.workerThreadId,
    teamId: assistant.teamId,
    workspaceId: assistant.workspaceId,
  });
  const remainingCredits = Number(ticket.creditCap) - spent;
  if (remainingCredits <= 0) {
    if (ticket.outcome === "blocked" && ticket.blockedReason === "credit_cap") {
      return "blocked";
    }
    const changed = await db.transaction(async (tx) => {
      const current = await findScopedTicketRow(ticketScope, tx, { forUpdate: true });
      if (!current || current.stage === "working" || current.stage === "ended") {
        return false;
      }
      await updateScopedTicketRow(tx, ticketScope, blockedValues("credit_cap", now));
      return true;
    });
    if (changed) {
      logger.warn("Assistant ticket has spent its credit cap; not starting a run", {
        assistantId: assistant.id,
        ticketId: ticket.id,
        creditCap: Number(ticket.creditCap),
        spent,
      });
      await notifyBlocked(ports, assistant, ticket, "credit_cap");
    }
    return "blocked";
  }

  const delivery = await deliveryFor(scope, candidate);
  // Each event goes with the note the Router routed it with: its
  // instruction for this delivery (what to rework, say).
  const notes = await listRouteNotes({
    ...scope,
    triggerIds: triggers.map((row) => row.id),
  });
  const content = renderWorkerDelivery({
    kind: delivery.kind,
    ticket,
    triggers: triggers.map((row) => ({
      ...toRenderTrigger(row),
      routerNote: notes.get(row.id) ?? null,
    })),
    consecutiveFailures: ticket.consecutiveFailures,
  });

  let runId: string;
  try {
    const started = await ports.startTurn({
      origin: "assistant_ticket",
      visibility,
      workspaceId: assistant.workspaceId,
      userId: ticket.payerUserId,
      threadId: ticket.workerThreadId,
      idempotencyKey: deterministicId(
        "assistant-ticket-run",
        ticket.id,
        ...delivery.keyParts,
      ),
      title: ticket.title,
      content,
      creditCap: remainingCredits,
      hostContext: { assistantId: assistant.id, ticketId: ticket.id },
    });
    runId = started.run.id;
  } catch (error) {
    if (isContentError(error) && error.code === CHAT_RUN_ALREADY_ACTIVE) {
      // Something is still running in the worker's conversation; try again
      // next tick, nothing counted.
      logger.warn("Assistant worker conversation is busy; retrying next tick", {
        assistantId: assistant.id,
        ticketId: ticket.id,
      });
      return "skipped";
    }
    logger.error("Failed to start an assistant worker run", {
      assistantId: assistant.id,
      ticketId: ticket.id,
      error: errorMessage(error),
    });
    const blocked = await db.transaction(async (tx) => {
      const current = await findScopedTicketRow(ticketScope, tx, { forUpdate: true });
      if (!current || current.stage === "working" || current.stage === "ended") {
        return false;
      }
      const failures = current.consecutiveFailures + 1;
      if (failures >= ASSISTANT_LIMITS.consecutiveFailuresToBlock) {
        const alreadyBlocked =
          current.outcome === "blocked" && current.blockedReason === "repeated_failure";
        await updateScopedTicketRow(tx, ticketScope, {
          ...blockedValues("repeated_failure", now),
          consecutiveFailures: failures,
        });
        return !alreadyBlocked;
      }
      await updateScopedTicketRow(tx, ticketScope, {
        consecutiveFailures: failures,
        updatedAt: now,
      });
      return false;
    });
    if (blocked) await notifyBlocked(ports, assistant, ticket, "repeated_failure");
    return "skipped";
  }

  // The run exists; record it. A worker quick enough to `report` before this
  // write has already moved the ticket on (its `updated_at` changed): then
  // only the run is recorded, and step 3 settles it without overriding the
  // report.
  await db.transaction(async (tx) => {
    const current = await findScopedTicketRow(ticketScope, tx, { forUpdate: true });
    if (!current) return;
    const untouched =
      current.updatedAt.getTime() === ticket.updatedAt.getTime() &&
      current.stage !== "ended";
    await updateScopedTicketRow(tx, ticketScope, {
      currentRunId: runId,
      updatedAt: now,
      ...(untouched
        ? { stage: "working" as const, outcome: null, blockedReason: null }
        : {}),
    });
    await markTriggersDeliveredRows(tx, {
      ...scope,
      ids: triggers.map((row) => row.id),
      now,
    });
  });
  return "started";
}

async function dispatchWorkers(
  assistant: AssistantRow,
  now: Date,
  ports: AssistantPorts,
): Promise<void> {
  const scope = scopeOf(assistant);
  const candidates = await listDispatchCandidates(scope);
  if (candidates.length === 0) return;

  // Worker conversations share the Router conversation's visibility. A
  // Router conversation that is gone is a broken assistant, not a reason to
  // pick a visibility on our own.
  const visibility = await findThreadVisibility({
    threadId: assistant.routerThreadId,
    teamId: assistant.teamId,
    workspaceId: assistant.workspaceId,
  });
  if (!visibility) {
    throw new Error(
      `The assistant's Router conversation '${assistant.routerThreadId}' is missing.`,
    );
  }

  let used = await countWorkingTicketRows(scope);
  const { workerSlots, reservedMemberSlots } = ASSISTANT_LIMITS;
  for (const candidate of candidates) {
    if (used >= workerSlots + reservedMemberSlots) break;
    // Past the shared slots, only a member waiting on a ticket may take the
    // reserved one.
    if (used >= workerSlots && !candidate.hasMemberInput) continue;
    try {
      const outcome = await dispatchTicket(
        assistant,
        candidate,
        visibility,
        now,
        ports,
      );
      if (outcome === "started") used += 1;
    } catch (error) {
      logger.error("Failed to dispatch an assistant ticket", {
        assistantId: assistant.id,
        ticketId: candidate.ticket.id,
        error: errorMessage(error),
      });
    }
  }
}

// ── 5. The Router's next batch ──────────────────────────────────────────

/**
 * The batch's key. A first look at these events is exactly
 * `routerBatchKey(ids)`; an event the Router already had and left
 * undecided (`eval_attempts > 0`) enters it with its attempt count, so a
 * retried batch of the very same events never reuses the key — and with
 * it the idempotency key — of the run that already ran.
 */
export function batchKeyFor(
  rows: ReadonlyArray<Pick<AssistantTriggerRow, "id" | "evalAttempts">>,
): string {
  return routerBatchKey(
    rows.map((row) =>
      row.evalAttempts > 0 ? `${row.id}#${row.evalAttempts}` : row.id,
    ),
  );
}

type RouterStartOutcome = "started" | "busy" | "failed" | "claim_short";

/**
 * Starts the Router's turn on an already-claimed batch and records it on the
 * assistant. A 409 (the Router conversation already has a run) gives this
 * caller's own freshly claimed events back to `pending_eval` with no attempt
 * counted (Review Focus 1) — unless a run is already recorded under this
 * batch's key: then that run (started by the tick's recovery) holds them,
 * and they stay `in_eval` for it. Restarting a batch whose run was never
 * recorded (`recovering`), a 409 leaves the events `in_eval`: the run
 * holding the conversation may be this very batch's, started by a
 * concurrent kick, and the next tick tries again. Any other failure counts as one evaluation
 * attempt, the same as a Router run that ended without deciding them, so a
 * start that keeps failing ends in `unavailable` and the steward is told
 * rather than retrying forever.
 */
async function startRouterTurn(
  assistant: AssistantRow,
  batchKey: string,
  rows: readonly AssistantTriggerRow[],
  ports: AssistantPorts,
  options: { recovering: boolean },
): Promise<RouterStartOutcome> {
  const scope = scopeOf(assistant);
  const payerUserId = rows[0]!.payerUserId!;
  const ordered = [...rows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  const context = await fetchRouterBatchContext({
    ...scope,
    payerUserId,
    reportingTicketIds: [
      ...new Set(ordered.flatMap((row) => (row.ticketId ? [row.ticketId] : []))),
    ],
  });
  const content = renderBatch({
    triggers: ordered.map(toRenderTrigger),
    feedItems: context.feedItems,
    relatedTickets: context.relatedTickets,
  });

  let runId: string;
  try {
    const started = await ports.startTurn({
      origin: "assistant_router",
      existingThread: true,
      workspaceId: assistant.workspaceId,
      userId: payerUserId,
      threadId: assistant.routerThreadId,
      idempotencyKey: batchKey,
      title: ROUTER_THREAD_TITLE,
      content,
      hostContext: { assistantId: assistant.id, batchKey },
    });
    runId = started.run.id;
  } catch (error) {
    if (isContentError(error) && error.code === CHAT_RUN_ALREADY_ACTIVE) {
      const release =
        !options.recovering &&
        !(await chatRunExistsForKey({ ...scope, idempotencyKey: batchKey }));
      if (release) {
        await releaseInEvalTriggerRows(db, {
          ...scope,
          routerBatchKey: batchKey,
          ids: rows.map((row) => row.id),
        });
      }
      logger.info("Assistant Router conversation is busy; retrying the batch later", {
        assistantId: assistant.id,
        batchKey,
        released: release,
      });
      return "busy";
    }
    logger.error("Failed to start the assistant Router", {
      assistantId: assistant.id,
      batchKey,
      error: errorMessage(error),
    });
    const requeued = await requeueOrExpireInEvalTriggerRows(db, {
      ...scope,
      routerBatchKey: batchKey,
      evalMaxAttempts: ASSISTANT_LIMITS.evalMaxAttempts,
    });
    const unavailable = requeued.filter((row) => row.status === "unavailable");
    if (unavailable.length > 0) {
      await ports.notify({
        kind: "assistant_unavailable",
        teamId: assistant.teamId,
        userId: assistant.stewardUserId,
        ref: { kind: "assistant", id: assistant.id },
        payload: {
          assistantId: assistant.id,
          unavailableCount: unavailable.length,
        },
      });
    }
    return "failed";
  }

  // Written right after the start, and only over an empty slot (or the
  // same run): a run that already ended by now is simply found ended by the
  // next settle step; a different run already recorded is never replaced,
  // and this batch stays `in_eval` until it is (see `startNextRouterBatch`).
  const recorded = await recordRouterRunRow(db, {
    ...scope,
    runId,
    batchKey,
    now: new Date(),
  });
  if (!recorded) {
    logger.warn("Assistant Router run started while another was recorded; left for a later tick", {
      assistantId: assistant.id,
      batchKey,
      runId,
    });
  }
  return "started";
}

/**
 * Claims `batch` and starts the Router on it. A claim that got fewer events
 * than selected (something else took one in between) gives back what it
 * did get, with no attempt counted, and starts nothing: the next tick
 * selects again from what is really pending.
 */
export async function claimAndStartRouterBatch(
  assistant: AssistantRow,
  batch: RouterBatch,
  ports: AssistantPorts = assistantPorts,
): Promise<RouterStartOutcome> {
  const scope = scopeOf(assistant);
  const selected = await findTriggerRowsByIds({
    ids: batch.triggerIds,
    teamId: assistant.teamId,
    workspaceId: assistant.workspaceId,
    assistantId: assistant.id,
  });
  const batchKey = batchKeyFor(selected);
  const { claimedTriggerIds } = await claimBatch(assistant.id, batch, batchKey, {
    teamId: assistant.teamId,
    workspaceId: assistant.workspaceId,
  });
  if (claimedTriggerIds.length !== batch.triggerIds.length) {
    await releaseInEvalTriggerRows(db, {
      ...scope,
      routerBatchKey: batchKey,
      ids: claimedTriggerIds,
    });
    logger.warn("Assistant Router batch claim came up short; retrying next tick", {
      assistantId: assistant.id,
      selected: batch.triggerIds.length,
      claimed: claimedTriggerIds.length,
    });
    return "claim_short";
  }
  const claimed = await findTriggerRowsByIds({
    ids: claimedTriggerIds,
    teamId: assistant.teamId,
    workspaceId: assistant.workspaceId,
    assistantId: assistant.id,
  });
  return startRouterTurn(assistant, batchKey, claimed, withLoggedNotify(ports), {
    recovering: false,
  });
}

/**
 * Starts the Router on its next batch when it is idle (no run recorded on
 * the assistant). Events already claimed into a batch whose run was never
 * recorded (the process stopped between the claim and the write) go first,
 * under their own key: starting is idempotent on it, so this finds the run
 * if there is one and starts it if there is not. Only the tick does this
 * (`recoverOrphans`); a kick leaves such a batch alone, since it may be
 * another caller's start still in progress. Otherwise the next batch is
 * selected payer by payer; a payer without credits is passed over and told
 * (`assistant_ticket_blocked` about the assistant, reason
 * `insufficient_credits`; repeats within a day merge into one), their
 * events left `pending_eval` with no attempt counted, and the next payer's
 * batch is tried in the same pass (Review Focus 3).
 */
async function startNextRouterBatch(
  assistantId: string,
  scopeHint: AssistantScope,
  ports: AssistantPorts,
  options: { recoverOrphans: boolean },
): Promise<void> {
  const assistant = await findAssistantRowById({
    id: assistantId,
    teamId: scopeHint.teamId,
    workspaceId: scopeHint.workspaceId,
  });
  if (!assistant || assistant.status !== "active" || assistant.currentRouterRunId) {
    return;
  }
  const scope = scopeOf(assistant);

  const inEval = await listAllInEvalTriggerRows(scope);
  if (inEval.length > 0) {
    if (!options.recoverOrphans) return;
    const batchKey = inEval[0]!.routerBatchKey!;
    const rows = inEval.filter((row) => row.routerBatchKey === batchKey);
    logger.warn("Assistant Router batch was claimed but never recorded; starting it again", {
      assistantId,
      batchKey,
    });
    await startRouterTurn(assistant, batchKey, rows, ports, { recovering: true });
    return;
  }

  const pending = await listPendingEvalTriggerRows(scope);
  const rows: PendingTrigger[] = [];
  for (const row of pending) {
    if (!row.payerUserId) {
      logger.error("Assistant event has no payer; it cannot be evaluated", {
        assistantId,
        triggerId: row.id,
      });
      continue;
    }
    rows.push({
      id: row.id,
      payerUserId: row.payerUserId,
      sourceKind: row.sourceKind,
      createdAt: row.createdAt,
    });
  }

  const excluded = new Set<string>();
  for (;;) {
    const batch = selectNextBatch(rows, excluded);
    if (!batch) return;
    const hasCredits = await ports.hasCredits({
      teamId: assistant.teamId,
      userId: batch.payerUserId,
    });
    if (!hasCredits) {
      logger.info("Assistant Router batch waits for its payer's credits", {
        assistantId,
        payerUserId: batch.payerUserId,
        events: batch.triggerIds.length,
      });
      excluded.add(batch.payerUserId);
      await ports.notify({
        kind: "assistant_ticket_blocked",
        teamId: assistant.teamId,
        userId: batch.payerUserId,
        ref: { kind: "assistant", id: assistant.id },
        payload: {
          assistantId: assistant.id,
          reason: "insufficient_credits",
        },
      });
      continue;
    }
    await claimAndStartRouterBatch(assistant, batch, ports);
    return;
  }
}

// ── The tick and the kick ───────────────────────────────────────────────

async function tickAssistant(
  row: AssistantRow,
  now: Date,
  ports: AssistantPorts,
): Promise<void> {
  const scope = scopeOf(row);
  const assistant = await findAssistantRowById({
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
  });
  if (!assistant || assistant.status !== "active") return;

  const stewardAccess = await ports.workspaceAccess({
    workspaceId: assistant.workspaceId,
    userId: assistant.stewardUserId,
  });
  if (!stewardAccess) {
    await pauseForStewardLeft(assistant, now, ports);
    return;
  }

  await settleRouterRun(assistant, ports);
  await settleWorkerRuns(assistant, now, ports);
  await dispatchWorkers(assistant, now, ports);
  await startNextRouterBatch(assistant.id, scope, ports, { recoverOrphans: true });
}

/** Set while a tick runs in this process; ticks never overlap. */
let tickInFlight = false;

/**
 * One scheduler pass over every active assistant. Only one runs at a time
 * in this process (the scheduler is a single process): a call while one is
 * still going returns at once. Each assistant runs on its own: one that
 * fails is logged without stopping the rest.
 */
export async function runAssistantTick(
  now: Date = new Date(),
  ports: AssistantPorts = assistantPorts,
): Promise<void> {
  if (tickInFlight) {
    logger.warn("Assistant tick skipped: the previous one is still running");
    return;
  }
  tickInFlight = true;
  try {
    const safePorts = withLoggedNotify(ports);
    const rows = await listActiveAssistantRows();
    for (const row of rows) {
      try {
        await tickAssistant(row, now, safePorts);
      } catch (error) {
        logger.error("Assistant tick failed", {
          assistantId: row.id,
          error: errorMessage(error),
        });
      }
    }
  } finally {
    tickInFlight = false;
  }
}

/**
 * Best-effort: right after a member's message, start the Router on its next
 * batch if it is idle, so the member does not wait for the next tick. It
 * does nothing else (settling runs and dispatching workers are the tick's),
 * and never throws; whatever it cannot do, the tick does. Safe to run
 * alongside a tick: see the file header.
 */
export async function kickAssistant(
  input: { assistantId: string; teamId: string; workspaceId: string },
  ports: AssistantPorts = assistantPorts,
): Promise<void> {
  try {
    await startNextRouterBatch(
      input.assistantId,
      {
        assistantId: input.assistantId,
        teamId: input.teamId,
        workspaceId: input.workspaceId,
      },
      withLoggedNotify(ports),
      { recoverOrphans: false },
    );
  } catch (error) {
    logger.error("Assistant kick failed; the next tick will pick it up", {
      assistantId: input.assistantId,
      error: errorMessage(error),
    });
  }
}
