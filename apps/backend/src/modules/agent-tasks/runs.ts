import { createHash } from "node:crypto";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import { SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX } from "@sourceweft/contracts";
import type {
  AgentTaskStatusReason,
  ScheduleSkipReason,
} from "@sourceweft/contracts/scheduled-tasks";
import { db } from "@sourceweft/db";
import { logger } from "../../shared/logger";
import type { NotificationKind } from "../notifications";
import {
  claimDispatchableOccurrences,
  materializeDueSchedules,
  retryOccurrence,
  type ClaimedOccurrence,
  type DueSlotPlan,
} from "../schedules";
import {
  AGENT_TASK_BLOCKED_RECHECK_MS,
  AGENT_TASK_DAILY_RUN_CAP,
  AGENT_TASK_MAX_CONSECUTIVE_FAILURES,
  AGENT_TASK_RUN_TIMEOUT_MS,
  AGENT_TASK_START_ATTEMPTS,
  AGENT_TASK_TICK_LIMIT,
  AGENT_TASK_UNAVAILABLE_GRACE_MS,
  AGENT_TASK_USER_CONCURRENCY,
} from "./limits";
import { agentTaskPorts, type AgentTaskPorts } from "./ports";
import {
  cancelPendingOccurrences,
  countRunsInFlight,
  countRunsStartedSince,
  findTaskById,
  finishStartedRun,
  hasRunInFlight,
  listBlockedTasks,
  listRunsToReconcile,
  markRunStarted,
  noteOnStartedRun,
  recordMaterializedSlot,
  setTaskStatus,
  settleDispatch,
  touchBlockedTask,
  updateTaskRow,
  type AgentTaskRow,
  type AgentTaskWithSchedule,
} from "./repository";
import {
  agentTaskRule,
  agentTaskScheduleState,
  planAgentTaskSlot,
} from "./schedule";

/** What a notification about a task points at. */
export const AGENT_TASK_NOTIFICATION_REF = "agent_task";

/** The chat run error code of an approval nobody answered in time. */
const APPROVAL_EXPIRED_CODE = "TOOL_APPROVAL_EXPIRED";

/** A UUID-shaped id derived from `parts`: same parts, same id. */
export function deterministicId(...parts: string[]) {
  const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/**
 * The conversation and the run of one slot, derived from the task and the
 * slot so a replayed dispatch finds the ones it already made. The slot id is
 * random (or derived from the caller's own key), so neither can be guessed
 * and claimed in advance by someone else.
 */
export function scheduledRunIdentity(taskId: string, occurrenceId: string) {
  return {
    threadId: deterministicId("agent-task-thread", taskId, occurrenceId),
    idempotencyKey: `${SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX}scheduled:${occurrenceId}`,
  };
}

function dateInZone(instant: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

async function notifyOwner(
  ports: AgentTaskPorts,
  task: AgentTaskRow,
  kind: NotificationKind,
  payload: Record<string, string | number | boolean | null> = {},
  options: { inAppOnly?: boolean } = {},
) {
  try {
    await ports.notify({
      kind,
      teamId: task.teamId,
      userId: task.ownerUserId,
      ref: { kind: AGENT_TASK_NOTIFICATION_REF, id: task.id },
      // Never the prompt or the result: only what a list row may show.
      payload: { taskName: task.name, ...payload },
      // The task's own switch can only turn email off, never on for a kind
      // that is in-app only.
      ...(options.inAppOnly || !task.notifyEmail ? { email: false } : {}),
    });
  } catch (error) {
    // A notification never decides what happens to the task.
    logger.error("Failed to notify about a scheduled task", {
      taskId: task.id,
      kind,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ── Transitions the platform makes ──────────────────────────────────────────

const STOPPED_SCHEDULE = { enabled: false, nextDueAt: null } as const;

/**
 * Stops an active (or blocked) task because of something outside it. Returns
 * the task when this call made the change, null when it was already stopped,
 * so the caller notifies exactly once.
 */
async function stopTask(
  ports: AgentTaskPorts,
  input: {
    taskId: string;
    status: "blocked" | "paused";
    reason: AgentTaskStatusReason;
    from: ReadonlyArray<AgentTaskRow["status"]>;
    now: Date;
  },
): Promise<AgentTaskRow | null> {
  const changed = await db.transaction(async (tx) => {
    const current = await findTaskById(input.taskId, tx, { forUpdate: true });
    if (!current || !input.from.includes(current.task.status)) return null;
    await cancelPendingOccurrences(tx, current.schedule.id, input.now);
    return setTaskStatus(tx, {
      taskId: current.task.id,
      scheduleId: current.schedule.id,
      status: input.status,
      reason: input.reason,
      schedule: STOPPED_SCHEDULE,
      now: input.now,
    });
  });
  if (!changed) return null;
  await ports.audit({
    teamId: changed.task.teamId,
    actorUserId: null,
    action:
      input.status === "blocked" ? "agent_task.blocked" : "agent_task.paused",
    targetType: "agent_task",
    targetId: changed.task.id,
    metadata: { reason: input.reason },
  });
  return changed.task;
}

/**
 * Puts a blocked task back to work from now on. Slots that passed while it
 * was blocked are not made up for: the schedule starts at its next fire time.
 */
async function reactivateTask(
  ports: AgentTaskPorts,
  taskId: string,
  now: Date,
) {
  const changed = await db.transaction(async (tx) => {
    const current = await findTaskById(taskId, tx, { forUpdate: true });
    if (!current || current.task.status !== "blocked") return null;
    const rule = agentTaskRule(current.schedule);
    const schedule = agentTaskScheduleState({
      taskId,
      rule,
      timezone: current.schedule.timezone,
      enabled: true,
      now,
    });
    // A one-time task whose moment passed while it was blocked has nothing
    // left to do.
    const spent = rule.kind === "once" && !schedule.enabled;
    return setTaskStatus(tx, {
      taskId,
      scheduleId: current.schedule.id,
      status: spent ? "completed" : "active",
      reason: null,
      schedule,
      now,
    });
  });
  if (!changed) return;
  await ports.audit({
    teamId: changed.task.teamId,
    actorUserId: null,
    action: "agent_task.resumed",
    targetType: "agent_task",
    targetId: taskId,
    metadata: { status: changed.task.status },
  });
}

// ── Materialize and claim ───────────────────────────────────────────────────

/**
 * One occurrence for the newest elapsed slot of every due task. A slot late
 * enough is marked as a catch-up run; one older than a period (at most a day)
 * is recorded as missed instead of run, as are all slots before it. A task
 * only gets here while its schedule is enabled, and pausing or blocking it
 * disables the schedule, so every slot that is late here is late because the
 * platform was.
 */
export async function materializeAgentTaskSlots(
  input: { now: Date; limit?: number },
  ports: AgentTaskPorts = agentTaskPorts,
) {
  // One-time tasks whose only slot was too old to run.
  const missedOnce: string[] = [];
  const count = await materializeDueSchedules<DueSlotPlan>({
    taskKind: "agent_task",
    now: input.now,
    limit: input.limit ?? AGENT_TASK_TICK_LIMIT,
    computeSlot: (schedule, now) => {
      try {
        return planAgentTaskSlot(schedule, now);
      } catch (error) {
        // One schedule that cannot be read must not stop all the others.
        logger.error("Failed to plan a scheduled task's slot", {
          scheduleId: schedule.id,
          taskId: schedule.agentTaskId,
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    onMaterialized: async (tx, schedule, slot) => {
      await recordMaterializedSlot(tx, {
        schedule,
        scheduledFor: slot.scheduledFor,
        isCatchUp: slot.isCatchUp,
        expired: slot.expired,
        missed: slot.missed,
        now: input.now,
      });
      if (slot.expired && !slot.nextDueAt && schedule.agentTaskId) {
        missedOnce.push(schedule.agentTaskId);
      }
    },
  });
  for (const taskId of missedOnce) {
    const completed = await db.transaction(async (tx) => {
      const current = await findTaskById(taskId, tx, { forUpdate: true });
      if (!current || current.task.status !== "active") return null;
      return setTaskStatus(tx, {
        taskId,
        scheduleId: current.schedule.id,
        status: "completed",
        reason: null,
        schedule: STOPPED_SCHEDULE,
        now: input.now,
      });
    });
    if (completed) {
      await notifyOwner(ports, completed.task, "task_run_failed", {
        reason: "missed_platform_down",
      });
    }
  }
  return count;
}

export async function claimAgentTaskOccurrences(input: {
  now: Date;
  limit?: number;
}) {
  return claimDispatchableOccurrences({
    taskKind: "agent_task",
    now: input.now,
    limit: input.limit ?? AGENT_TASK_TICK_LIMIT,
    // A run asked for by hand lives on a schedule that may be disabled (a
    // draft, a paused task, a manual rule). Dispatch checks the task's status.
    includeDisabledSchedules: true,
    // Overlap is a skip decided at dispatch, never a wait.
    isTargetBusy: async () => false,
  });
}

// ── Dispatch ────────────────────────────────────────────────────────────────

const SCHEDULED_STATUSES: ReadonlyArray<AgentTaskRow["status"]> = ["active"];
/** "Run now" also works on a task that is not enabled. */
export const RUN_NOW_STATUSES: ReadonlyArray<AgentTaskRow["status"]> = [
  "draft",
  "active",
  "paused",
];

function isPermanentStartError(error: unknown) {
  const status = (error as { statusCode?: unknown })?.statusCode;
  return typeof status === "number" && status >= 400 && status < 500;
}

/**
 * Decides what a claimed slot does and does it: start the run, or record why
 * not. Every reason a slot does not run ends up on the occurrence, where the
 * owner can see it. Safe to replay: the conversation and run ids are derived
 * from the slot.
 *
 * Whatever goes wrong before a run exists is retried with backoff, three
 * attempts in all, and then fails the slot; one task's trouble never stops
 * the slots after it. Once a run exists it is never started again: it may
 * already have spent credits.
 */
export async function dispatchAgentTaskOccurrence(
  item: ClaimedOccurrence,
  ports: AgentTaskPorts = agentTaskPorts,
  now: Date = new Date(),
): Promise<void> {
  const { occurrence, schedule } = item;
  try {
    await decideAndStart(item, ports, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed to start a scheduled task run", {
      taskId: schedule.agentTaskId,
      occurrenceId: occurrence.id,
      message,
    });
    const failed = isPermanentStartError(error)
      ? await settleDispatch({
          occurrenceId: occurrence.id,
          status: "failed",
          error: message,
          now,
        })
      : await retryOccurrence({
          occurrenceId: occurrence.id,
          attempts: occurrence.attempts + 1,
          maxAttempts: AGENT_TASK_START_ATTEMPTS,
          error: message,
          errorCode: "AGENT_TASK_START_FAILED",
        });
    if (failed && schedule.agentTaskId) {
      await recordFailure(ports, schedule.agentTaskId, {
        manual: occurrence.triggerKind === "manual",
        now,
      });
    }
  }
}

async function decideAndStart(
  item: ClaimedOccurrence,
  ports: AgentTaskPorts,
  now: Date,
): Promise<void> {
  const { occurrence, schedule } = item;
  const found = schedule.agentTaskId
    ? await findTaskById(schedule.agentTaskId)
    : null;
  const task = found?.task;
  const manual = occurrence.triggerKind === "manual";
  if (
    !task ||
    !(manual ? RUN_NOW_STATUSES : SCHEDULED_STATUSES).includes(task.status)
  ) {
    await settleDispatch({
      occurrenceId: occurrence.id,
      status: "cancelled",
      error: "task_not_runnable",
      now,
    });
    return;
  }

  const stop = (
    status: "skipped" | "blocked",
    skipReason: ScheduleSkipReason,
  ) => settleDispatch({ occurrenceId: occurrence.id, status, skipReason, now });

  if (
    !(await ports.hasWorkspaceAccess({
      workspaceId: task.workspaceId,
      userId: task.ownerUserId,
    }))
  ) {
    // Nobody else pays for it and nobody takes it over: the task stops.
    await stop("blocked", "owner_left");
    const paused = await stopTask(ports, {
      taskId: task.id,
      status: "paused",
      reason: "owner_left",
      from: ["draft", "active", "blocked"],
      now,
    });
    if (paused) await notifyOwner(ports, paused, "task_paused_owner_left");
    return;
  }

  if (!(await ports.toolsAvailable(task))) {
    await stop("blocked", "tools_unavailable");
    const blocked = await stopTask(ports, {
      taskId: task.id,
      status: "blocked",
      reason: "tools_unavailable",
      from: ["active"],
      now,
    });
    if (blocked) {
      await notifyOwner(
        ports,
        blocked,
        "task_tools_unavailable",
        { state: "blocked" },
        { inAppOnly: true },
      );
    }
    return;
  }

  if (await ports.credentialsExpired(task)) {
    // An MCP server the task uses wants the owner to sign in again; running
    // without it would only make the run fail. It waits for the owner.
    await stop("blocked", "auth_expired");
    const blocked = await stopTask(ports, {
      taskId: task.id,
      status: "blocked",
      reason: "auth_expired",
      from: ["active"],
      now,
    });
    if (blocked) {
      await notifyOwner(
        ports,
        blocked,
        "task_blocked_auth",
        {},
        { inAppOnly: true },
      );
    }
    return;
  }

  if (
    await hasRunInFlight({
      scheduleId: schedule.id,
      occurrenceId: occurrence.id,
      now,
    })
  ) {
    await stop("skipped", "previous_run_active");
    return;
  }
  if (
    (await countRunsInFlight(task.ownerUserId)) >= AGENT_TASK_USER_CONCURRENCY
  ) {
    await stop("skipped", "user_concurrency_limit");
    return;
  }
  if (
    (await countRunsStartedSince(
      task.ownerUserId,
      new Date(now.getTime() - 24 * 60 * 60_000),
    )) >= AGENT_TASK_DAILY_RUN_CAP
  ) {
    await stop("skipped", "user_daily_cap");
    return;
  }

  // A run on the owner's own model key spends no credits.
  if (task.requestJson.llm?.executionMode !== "BYOK") {
    const billingTeamId = await ports.resolveBillingTeamId({
      workspaceId: task.workspaceId,
      teamId: task.teamId,
      userId: task.ownerUserId,
    });
    if (
      !(await ports.hasCredits({
        teamId: billingTeamId,
        userId: task.ownerUserId,
      }))
    ) {
      await stop("blocked", "insufficient_credits");
      const blocked = await stopTask(ports, {
        taskId: task.id,
        status: "blocked",
        reason: "insufficient_credits",
        from: ["active"],
        now,
      });
      // A run asked for by hand on a task that is not enabled changes no
      // status, but the owner is told all the same.
      await notifyOwner(ports, blocked ?? task, "task_blocked_quota");
      return;
    }
  }

  const identity = scheduledRunIdentity(task.id, occurrence.id);
  const request = task.requestJson;
  const started = await ports.startTurn({
    workspaceId: task.workspaceId,
    userId: task.ownerUserId,
    threadId: identity.threadId,
    idempotencyKey: identity.idempotencyKey,
    title: `${task.name} · ${dateInZone(occurrence.scheduledFor, schedule.timezone)}`,
    content: task.prompt,
    sourceIds: request.sourceIds,
    tools: {
      skillIds: request.skillIds,
      [AGENT_TOOL_NAMES.webSearch]: { enabled: request.webAccess },
      [AGENT_TOOL_NAMES.webFetch]: { enabled: request.webAccess },
      ...(request.mcp.installIds.length > 0
        ? { mcp: { installIds: request.mcp.installIds } }
        : {}),
    },
    timezone: schedule.timezone,
    llm: request.llm,
    modelSettings: request.modelSettings,
  });

  const marked = await markRunStarted({
    occurrenceId: occurrence.id,
    chatRunId: started.run.id,
    threadId: started.thread.id,
    taskVersion: task.version,
    now,
  });
  if (marked && occurrence.isCatchUp) {
    await notifyOwner(
      ports,
      task,
      "task_run_catch_up",
      {
        threadId: started.thread.id,
        scheduledFor: occurrence.scheduledFor.toISOString(),
      },
      { inAppOnly: true },
    );
  }
}

// ── Outcomes ────────────────────────────────────────────────────────────────

/**
 * Counts a failed run against the task and pauses it after too many in a
 * row. A run asked for by hand is a trial: it is reported but not counted.
 */
async function recordFailure(
  ports: AgentTaskPorts,
  taskId: string,
  input: { manual: boolean; now: Date; threadId?: string | null },
) {
  const result = await db.transaction(async (tx) => {
    const current = await findTaskById(taskId, tx, { forUpdate: true });
    if (!current) return null;
    const failures = current.task.consecutiveFailures + (input.manual ? 0 : 1);
    const pause =
      current.task.status === "active" &&
      failures >= AGENT_TASK_MAX_CONSECUTIVE_FAILURES;
    const once = agentTaskRule(current.schedule).kind === "once";
    const extra = {
      consecutiveFailures: failures,
      ...(input.manual ? { trialRunAt: input.now } : {}),
    };
    if (pause) {
      await cancelPendingOccurrences(tx, current.schedule.id, input.now);
      const next = await setTaskStatus(tx, {
        taskId,
        scheduleId: current.schedule.id,
        status: "paused",
        reason: "repeated_failure",
        schedule: STOPPED_SCHEDULE,
        now: input.now,
        extra,
      });
      return { task: next.task, paused: true };
    }
    if (once && !input.manual && current.task.status === "active") {
      // Its one moment has been used, whatever came of it.
      const next = await setTaskStatus(tx, {
        taskId,
        scheduleId: current.schedule.id,
        status: "completed",
        reason: null,
        schedule: STOPPED_SCHEDULE,
        now: input.now,
        extra,
      });
      return { task: next.task, paused: false };
    }
    return {
      task: await updateTaskRow(tx, taskId, { ...extra, updatedAt: input.now }),
      paused: false,
    };
  });
  if (!result) return;
  await notifyOwner(ports, result.task, "task_run_failed", {
    threadId: input.threadId ?? null,
  });
  if (result.paused) {
    await ports.audit({
      teamId: result.task.teamId,
      actorUserId: null,
      action: "agent_task.paused",
      targetType: "agent_task",
      targetId: taskId,
      metadata: { reason: "repeated_failure" },
    });
    await notifyOwner(ports, result.task, "task_paused_repeated_failure");
  }
}

async function recordSuccess(
  ports: AgentTaskPorts,
  taskId: string,
  input: { manual: boolean; now: Date; threadId: string | null },
) {
  const task = await db.transaction(async (tx) => {
    const current = await findTaskById(taskId, tx, { forUpdate: true });
    if (!current) return null;
    const extra = {
      consecutiveFailures: 0,
      ...(input.manual ? { trialRunAt: input.now } : {}),
    };
    if (
      !input.manual &&
      current.task.status === "active" &&
      agentTaskRule(current.schedule).kind === "once"
    ) {
      const next = await setTaskStatus(tx, {
        taskId,
        scheduleId: current.schedule.id,
        status: "completed",
        reason: null,
        schedule: STOPPED_SCHEDULE,
        now: input.now,
        extra,
      });
      return next.task;
    }
    return updateTaskRow(tx, taskId, { ...extra, updatedAt: input.now });
  });
  if (task?.notifyOnSuccess) {
    await notifyOwner(ports, task, "task_run_succeeded", {
      threadId: input.threadId,
    });
  }
}

type RunToReconcile = Awaited<ReturnType<typeof listRunsToReconcile>>[number];

export async function listAgentTaskRunsToReconcile(
  limit: number,
  now: Date = new Date(),
) {
  return listRunsToReconcile({
    limit,
    startedBefore: new Date(now.getTime() - AGENT_TASK_RUN_TIMEOUT_MS),
  });
}

/**
 * Brings a started run's outcome back onto its slot and its task: succeeded,
 * failed or cancelled, with the counters, status changes and notifications
 * that follow. A run that is still going is only touched when it has run too
 * long (stopped) or waits for an approval (the owner is told once).
 */
export async function reconcileAgentTaskRun(
  item: RunToReconcile,
  ports: AgentTaskPorts = agentTaskPorts,
  now: Date = new Date(),
): Promise<void> {
  const { occurrence, schedule, run } = item;
  const taskId = schedule.agentTaskId;
  if (!taskId) return;
  const manual = occurrence.triggerKind === "manual";

  const finish = async (
    status: "succeeded" | "failed" | "cancelled",
    error: string | null,
  ) => {
    const won = await db.transaction((tx) =>
      finishStartedRun(tx, { occurrenceId: occurrence.id, status, error, now }),
    );
    if (!won) return;
    const outcome = { manual, now, threadId: occurrence.threadId };
    if (status === "succeeded") await recordSuccess(ports, taskId, outcome);
    if (status === "failed") await recordFailure(ports, taskId, outcome);
  };

  if (!run) {
    await finish("failed", "run_missing");
    return;
  }
  switch (run.status) {
    case "completed":
      await finish("succeeded", null);
      return;
    case "failed":
      await finish("failed", run.errorCode ?? "CHAT_RUN_FAILED");
      return;
    case "cancelled":
      if (occurrence.lastError === "run_timeout") {
        await finish("failed", "run_timeout");
      } else if (run.errorCode === APPROVAL_EXPIRED_CODE) {
        await finish("failed", "approval_expired");
      } else {
        // Stopped by its owner from the conversation.
        await finish("cancelled", run.errorCode);
      }
      return;
    case "waiting_for_approval": {
      // Should not happen: nothing that asks for approval is bound. If it
      // does, the owner is told once and the approval expires on its own.
      const first = await noteOnStartedRun({
        occurrenceId: occurrence.id,
        note: "approval_requested",
        now,
      });
      const found = first ? await findTaskById(taskId) : null;
      if (found) {
        await notifyOwner(ports, found.task, "task_needs_approval", {
          threadId: occurrence.threadId,
        });
      }
      return;
    }
    default: {
      if (
        now.getTime() - run.createdAt.getTime() < AGENT_TASK_RUN_TIMEOUT_MS ||
        !occurrence.threadId
      ) {
        return;
      }
      await noteOnStartedRun({
        occurrenceId: occurrence.id,
        note: "run_timeout",
        now,
      });
      await ports.stopRun({
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        userId: run.userId,
        idempotencyKey: run.idempotencyKey,
      });
    }
  }
}

// ── Upkeep ──────────────────────────────────────────────────────────────────

async function recheckBlockedTask(
  ports: AgentTaskPorts,
  { task }: AgentTaskWithSchedule,
  now: Date,
) {
  if (
    !(await ports.hasWorkspaceAccess({
      workspaceId: task.workspaceId,
      userId: task.ownerUserId,
    }))
  ) {
    const paused = await stopTask(ports, {
      taskId: task.id,
      status: "paused",
      reason: "owner_left",
      from: ["blocked"],
      now,
    });
    if (paused) await notifyOwner(ports, paused, "task_paused_owner_left");
    return;
  }

  if (task.statusReason === "insufficient_credits") {
    // A payment state, not a fault: it waits for credits however long.
    const billingTeamId = await ports.resolveBillingTeamId({
      workspaceId: task.workspaceId,
      teamId: task.teamId,
      userId: task.ownerUserId,
    });
    if (
      await ports.hasCredits({
        teamId: billingTeamId,
        userId: task.ownerUserId,
      })
    ) {
      await reactivateTask(ports, task.id, now);
    } else {
      await touchBlockedTask(task.id, now);
    }
    return;
  }

  if (await ports.toolsAvailable(task)) {
    if (
      task.statusReason === "auth_expired" &&
      (await ports.credentialsExpired(task))
    ) {
      // Waits for the owner to sign in, however long that takes.
      await touchBlockedTask(task.id, now);
      return;
    }
    await reactivateTask(ports, task.id, now);
    return;
  }
  if (
    now.getTime() - task.statusChangedAt.getTime() <
    AGENT_TASK_UNAVAILABLE_GRACE_MS
  ) {
    await touchBlockedTask(task.id, now);
    return;
  }
  const paused = await stopTask(ports, {
    taskId: task.id,
    status: "paused",
    reason: "tools_unavailable",
    from: ["blocked"],
    now,
  });
  if (paused) {
    await notifyOwner(
      ports,
      paused,
      "task_tools_unavailable",
      { state: "paused" },
      { inAppOnly: true },
    );
  }
}

/**
 * Looks at blocked tasks again, each at most every ten minutes: one whose
 * block is gone goes back to work, one blocked on missing tools for three
 * days pauses for good.
 */
export async function recheckBlockedAgentTasks(
  now: Date = new Date(),
  ports: AgentTaskPorts = agentTaskPorts,
) {
  const blocked = await listBlockedTasks({
    checkedBefore: new Date(now.getTime() - AGENT_TASK_BLOCKED_RECHECK_MS),
    limit: AGENT_TASK_TICK_LIMIT,
  });
  for (const item of blocked) {
    try {
      await recheckBlockedTask(ports, item, now);
    } catch (error) {
      logger.error("Failed to recheck a blocked scheduled task", {
        taskId: item.task.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
