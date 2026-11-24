import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  agentTasks,
  chatThreadRuns,
  db,
  scheduleOccurrences,
  taskSchedules,
} from "@sourceweft/db";
import type {
  AgentTaskRequest,
  AgentTaskStatus,
  AgentTaskStatusReason,
  ScheduleSkipReason,
} from "@sourceweft/contracts/scheduled-tasks";
import { DISPATCH_LEASE_MS, type ScheduleTx } from "../schedules";

export type AgentTaskRow = typeof agentTasks.$inferSelect;
export type AgentTaskScheduleRow = typeof taskSchedules.$inferSelect;
export type AgentTaskOccurrenceRow = typeof scheduleOccurrences.$inferSelect;
export type AgentTaskChatRunRow = typeof chatThreadRuns.$inferSelect;
export type AgentTaskWithSchedule = {
  task: AgentTaskRow;
  schedule: AgentTaskScheduleRow;
};

/** The time columns of a schedule row, as `agentTaskScheduleState` returns them. */
export type ScheduleState = {
  specVersion: number;
  specJson: Record<string, unknown>;
  timezone: string;
  enabled: boolean;
  nextDueAt: Date | null;
};

type Executor = ScheduleTx | typeof db;

/** Statuses that count against a person's plan limit of active tasks. */
const ACTIVE_STATUSES: AgentTaskStatus[] = ["active", "blocked"];

/** The violated constraint's name when `error` is a unique violation. */
export function uniqueViolation(error: unknown): string | null {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    const record = candidate as { code?: string; constraint?: string } | null;
    if (record?.code === "23505") return record.constraint ?? "unique";
  }
  return null;
}

/**
 * Serializes everything that counts or changes one person's active tasks, so
 * two requests cannot both pass the plan limit. Held to the end of `tx`.
 */
export async function lockOwnerTasks(tx: ScheduleTx, ownerUserId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`agent_tasks:${ownerUserId}`}, 0))`,
  );
}

export async function countActiveTasks(
  executor: Executor,
  input: { teamId: string; ownerUserId: string; excludeTaskId?: string },
) {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.teamId, input.teamId),
        eq(agentTasks.ownerUserId, input.ownerUserId),
        inArray(agentTasks.status, ACTIVE_STATUSES),
        input.excludeTaskId
          ? ne(agentTasks.id, input.excludeTaskId)
          : undefined,
      ),
    );
  return row?.count ?? 0;
}

export async function insertTask(
  tx: ScheduleTx,
  input: {
    id: string;
    teamId: string;
    workspaceId: string;
    ownerUserId: string;
    name: string;
    prompt: string;
    request: AgentTaskRequest;
    status: AgentTaskStatus;
    notifyOnSuccess?: boolean;
    notifyEmail?: boolean;
    schedule: ScheduleState;
    now: Date;
  },
): Promise<AgentTaskWithSchedule> {
  const [task] = await tx
    .insert(agentTasks)
    .values({
      id: input.id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      name: input.name,
      prompt: input.prompt,
      requestJson: input.request,
      status: input.status,
      statusChangedAt: input.now,
      ...(input.notifyOnSuccess === undefined
        ? {}
        : { notifyOnSuccess: input.notifyOnSuccess }),
      ...(input.notifyEmail === undefined
        ? {}
        : { notifyEmail: input.notifyEmail }),
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  const [schedule] = await tx
    .insert(taskSchedules)
    .values({
      id: randomUUID(),
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      taskKind: "agent_task",
      ownerKind: "user",
      ownerUserId: input.ownerUserId,
      agentTaskId: input.id,
      ...input.schedule,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  return { task: task!, schedule: schedule! };
}

const withSchedule = { task: agentTasks, schedule: taskSchedules };

function joined(executor: Executor) {
  return executor
    .select(withSchedule)
    .from(agentTasks)
    .innerJoin(taskSchedules, eq(taskSchedules.agentTaskId, agentTasks.id));
}

/**
 * One task of one owner. The owner is part of the lookup, so somebody else's
 * task is simply not found.
 */
export async function findOwnedTask(
  input: { taskId: string; ownerUserId: string; workspaceId: string },
  executor: Executor = db,
  options: { forUpdate?: boolean } = {},
): Promise<AgentTaskWithSchedule | null> {
  const query = joined(executor)
    .where(
      and(
        eq(agentTasks.id, input.taskId),
        eq(agentTasks.ownerUserId, input.ownerUserId),
        eq(agentTasks.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  const [row] = options.forUpdate ? await query.for("update") : await query;
  return row ?? null;
}

/** For the scheduler, which acts on the stored row and no request. */
export async function findTaskById(
  taskId: string,
  executor: Executor = db,
  options: { forUpdate?: boolean } = {},
): Promise<AgentTaskWithSchedule | null> {
  const query = joined(executor).where(eq(agentTasks.id, taskId)).limit(1);
  const [row] = options.forUpdate ? await query.for("update") : await query;
  return row ?? null;
}

export async function listOwnedTasks(input: {
  workspaceId: string;
  ownerUserId: string;
}): Promise<AgentTaskWithSchedule[]> {
  return joined(db)
    .where(
      and(
        eq(agentTasks.workspaceId, input.workspaceId),
        eq(agentTasks.ownerUserId, input.ownerUserId),
        isNull(agentTasks.archivedAt),
      ),
    )
    .orderBy(desc(agentTasks.createdAt), desc(agentTasks.id));
}

export async function updateTaskRow(
  tx: ScheduleTx,
  taskId: string,
  values: Partial<typeof agentTasks.$inferInsert>,
) {
  const [row] = await tx
    .update(agentTasks)
    .set(values)
    .where(eq(agentTasks.id, taskId))
    .returning();
  return row!;
}

export async function updateScheduleState(
  tx: ScheduleTx,
  scheduleId: string,
  state: Partial<ScheduleState>,
  now: Date,
) {
  const [row] = await tx
    .update(taskSchedules)
    .set({ ...state, retryAt: null, updatedAt: now })
    .where(eq(taskSchedules.id, scheduleId))
    .returning();
  return row!;
}

/**
 * Moves a task to a new status and its schedule to the matching state. The
 * caller holds the task row (`forUpdate`) and has checked the transition.
 */
export async function setTaskStatus(
  tx: ScheduleTx,
  input: {
    taskId: string;
    scheduleId: string;
    status: AgentTaskStatus;
    reason: AgentTaskStatusReason | null;
    schedule: Partial<ScheduleState>;
    now: Date;
    extra?: Partial<typeof agentTasks.$inferInsert>;
  },
): Promise<AgentTaskWithSchedule> {
  const task = await updateTaskRow(tx, input.taskId, {
    status: input.status,
    statusReason: input.reason,
    statusChangedAt: input.now,
    updatedAt: input.now,
    ...input.extra,
  });
  const schedule = await updateScheduleState(
    tx,
    input.scheduleId,
    input.schedule,
    input.now,
  );
  return { task, schedule };
}

export async function deleteTaskRow(tx: ScheduleTx, taskId: string) {
  await tx.delete(agentTasks).where(eq(agentTasks.id, taskId));
}

// ── Occurrences ─────────────────────────────────────────────────────────────

export async function countOccurrences(executor: Executor, scheduleId: string) {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(scheduleOccurrences)
    .where(eq(scheduleOccurrences.scheduleId, scheduleId));
  return row?.count ?? 0;
}

/**
 * Cancels slots that have not started a run, when the task stops being
 * runnable (paused, blocked, archived, rule changed). Without this a slot
 * waiting for a retry would run after the task is enabled again, which is a
 * catch-up of a slot the owner never agreed to.
 */
export async function cancelPendingOccurrences(
  tx: ScheduleTx,
  scheduleId: string,
  now: Date,
) {
  await tx
    .update(scheduleOccurrences)
    .set({
      status: "cancelled",
      retryAt: null,
      leaseUntil: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduleOccurrences.scheduleId, scheduleId),
        eq(scheduleOccurrences.status, "pending"),
        eq(scheduleOccurrences.triggerKind, "schedule"),
      ),
    );
}

export async function findOccurrence(occurrenceId: string) {
  const [row] = await db
    .select()
    .from(scheduleOccurrences)
    .where(eq(scheduleOccurrences.id, occurrenceId))
    .limit(1);
  return row ?? null;
}

/**
 * Creates the slot of a run someone asked for, already leased to the caller
 * so it can be dispatched in the same request. Null when a slot with this id
 * or this exact time already exists.
 */
export async function insertManualOccurrence(input: {
  id: string;
  schedule: Pick<AgentTaskScheduleRow, "id" | "teamId" | "workspaceId">;
  now: Date;
}) {
  const [row] = await db
    .insert(scheduleOccurrences)
    .values({
      id: input.id,
      scheduleId: input.schedule.id,
      teamId: input.schedule.teamId,
      workspaceId: input.schedule.workspaceId,
      scheduledFor: input.now,
      status: "dispatching",
      triggerKind: "manual",
      attempts: 1,
      leaseUntil: new Date(input.now.getTime() + DISPATCH_LEASE_MS),
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/**
 * Projects a materialized slot onto its occurrence: whether it is a catch-up
 * run, or too old to run at all, and the older slots that were missed.
 */
export async function recordMaterializedSlot(
  tx: ScheduleTx,
  input: {
    schedule: Pick<AgentTaskScheduleRow, "id" | "teamId" | "workspaceId">;
    scheduledFor: Date;
    isCatchUp: boolean;
    expired: boolean;
    missed: Date[];
    now: Date;
  },
) {
  await tx
    .update(scheduleOccurrences)
    .set(
      input.expired
        ? {
            status: "skipped",
            skipReason: "missed_platform_down",
            isCatchUp: false,
            updatedAt: input.now,
          }
        : { isCatchUp: input.isCatchUp, updatedAt: input.now },
    )
    .where(
      and(
        eq(scheduleOccurrences.scheduleId, input.schedule.id),
        eq(scheduleOccurrences.scheduledFor, input.scheduledFor),
        eq(scheduleOccurrences.status, "pending"),
      ),
    );
  if (input.missed.length === 0) return;
  await tx
    .insert(scheduleOccurrences)
    .values(
      input.missed.map((scheduledFor) => ({
        id: randomUUID(),
        scheduleId: input.schedule.id,
        teamId: input.schedule.teamId,
        workspaceId: input.schedule.workspaceId,
        scheduledFor,
        status: "skipped" as const,
        skipReason: "missed_platform_down" as const,
        createdAt: input.now,
        updatedAt: input.now,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Ends a slot that was claimed but did not start a run. Only the holder of
 * the claim (`dispatching`) can; false when someone else already settled it.
 */
export async function settleDispatch(input: {
  occurrenceId: string;
  status: "skipped" | "blocked" | "cancelled" | "failed";
  skipReason?: ScheduleSkipReason;
  error?: string;
  now: Date;
}) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(scheduleOccurrences)
      .set({
        status: input.status,
        skipReason: input.skipReason ?? null,
        leaseUntil: null,
        retryAt: null,
        lastError: (input.error ?? input.skipReason ?? null)?.slice(0, 500),
        updatedAt: input.now,
      })
      .where(
        and(
          eq(scheduleOccurrences.id, input.occurrenceId),
          eq(scheduleOccurrences.status, "dispatching"),
        ),
      )
      .returning({ scheduleId: scheduleOccurrences.scheduleId });
    if (!row) return false;
    await tx
      .update(taskSchedules)
      .set({
        lastAttemptAt: input.now,
        lastErrorCode: (input.skipReason ?? input.error ?? null)?.slice(0, 200),
        updatedAt: input.now,
      })
      .where(eq(taskSchedules.id, row.scheduleId));
    return true;
  });
}

/** The claimed slot started a run: link it and wait for the run to end. */
export async function markRunStarted(input: {
  occurrenceId: string;
  chatRunId: string;
  threadId: string;
  taskVersion: number;
  now: Date;
}) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(scheduleOccurrences)
      .set({
        status: "queued",
        chatRunId: input.chatRunId,
        threadId: input.threadId,
        taskVersion: input.taskVersion,
        leaseUntil: null,
        retryAt: null,
        lastError: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(scheduleOccurrences.id, input.occurrenceId),
          eq(scheduleOccurrences.status, "dispatching"),
        ),
      )
      .returning({ scheduleId: scheduleOccurrences.scheduleId });
    if (!row) return false;
    await tx
      .update(taskSchedules)
      .set({
        lastAttemptAt: input.now,
        retryAt: null,
        lastErrorCode: null,
        updatedAt: input.now,
      })
      .where(eq(taskSchedules.id, row.scheduleId));
    return true;
  });
}

/** A run in flight for this schedule other than the given slot's own. */
export async function hasRunInFlight(input: {
  scheduleId: string;
  occurrenceId: string;
  now: Date;
}) {
  const [row] = await db
    .select({ id: scheduleOccurrences.id })
    .from(scheduleOccurrences)
    .where(
      and(
        eq(scheduleOccurrences.scheduleId, input.scheduleId),
        ne(scheduleOccurrences.id, input.occurrenceId),
        or(
          eq(scheduleOccurrences.status, "queued"),
          // Two slots of one task being dispatched at the same moment: the
          // lower id goes first, so exactly one of them sees the other.
          and(
            eq(scheduleOccurrences.status, "dispatching"),
            gte(scheduleOccurrences.leaseUntil, input.now),
            lt(scheduleOccurrences.id, input.occurrenceId),
          ),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

function ownerOccurrences(ownerUserId: string) {
  return and(
    eq(taskSchedules.taskKind, "agent_task"),
    eq(taskSchedules.ownerUserId, ownerUserId),
  );
}

/** Scheduled-task runs of one person that have started and not ended. */
export async function countRunsInFlight(ownerUserId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scheduleOccurrences)
    .innerJoin(
      taskSchedules,
      eq(scheduleOccurrences.scheduleId, taskSchedules.id),
    )
    .where(
      and(
        ownerOccurrences(ownerUserId),
        eq(scheduleOccurrences.status, "queued"),
      ),
    );
  return row?.count ?? 0;
}

/** Runs one person's tasks have started since `since`, however they ended. */
export async function countRunsStartedSince(ownerUserId: string, since: Date) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scheduleOccurrences)
    .innerJoin(
      taskSchedules,
      eq(scheduleOccurrences.scheduleId, taskSchedules.id),
    )
    .where(
      and(
        ownerOccurrences(ownerUserId),
        // Set when a run starts and never cleared.
        sql`${scheduleOccurrences.taskVersion} is not null`,
        gte(scheduleOccurrences.createdAt, since),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Started runs worth looking at: the chat run has ended, is waiting for an
 * approval nobody was told about yet, has been going for too long, or is
 * gone. Runs still going normally are left alone.
 */
export async function listRunsToReconcile(input: {
  limit: number;
  startedBefore: Date;
}) {
  return db
    .select({
      occurrence: scheduleOccurrences,
      schedule: taskSchedules,
      run: chatThreadRuns,
    })
    .from(scheduleOccurrences)
    .innerJoin(
      taskSchedules,
      eq(scheduleOccurrences.scheduleId, taskSchedules.id),
    )
    .leftJoin(
      chatThreadRuns,
      eq(scheduleOccurrences.chatRunId, chatThreadRuns.id),
    )
    .where(
      and(
        eq(scheduleOccurrences.status, "queued"),
        eq(taskSchedules.taskKind, "agent_task"),
        or(
          isNull(chatThreadRuns.id),
          inArray(chatThreadRuns.status, ["completed", "failed", "cancelled"]),
          and(
            eq(chatThreadRuns.status, "waiting_for_approval"),
            sql`${scheduleOccurrences.lastError} is distinct from 'approval_requested'`,
          ),
          and(
            inArray(chatThreadRuns.status, [
              "queued",
              "running",
              "cancel_requested",
            ]),
            lt(chatThreadRuns.createdAt, input.startedBefore),
          ),
        ),
      ),
    )
    .orderBy(asc(scheduleOccurrences.updatedAt))
    .limit(input.limit);
}

/** Leaves a note on a started run's slot without ending it. */
export async function noteOnStartedRun(input: {
  occurrenceId: string;
  note: string;
  now: Date;
}) {
  const rows = await db
    .update(scheduleOccurrences)
    .set({ lastError: input.note, updatedAt: input.now })
    .where(
      and(
        eq(scheduleOccurrences.id, input.occurrenceId),
        eq(scheduleOccurrences.status, "queued"),
        sql`${scheduleOccurrences.lastError} is distinct from ${input.note}`,
      ),
    )
    .returning({ id: scheduleOccurrences.id });
  return rows.length > 0;
}

/**
 * Ends a started run's slot. Only one caller wins; the rest get false and
 * must not repeat the side effects (counters, notifications).
 */
export async function finishStartedRun(
  tx: ScheduleTx,
  input: {
    occurrenceId: string;
    status: "succeeded" | "failed" | "cancelled";
    error: string | null;
    now: Date;
  },
) {
  const [row] = await tx
    .update(scheduleOccurrences)
    .set({
      status: input.status,
      leaseUntil: null,
      retryAt: null,
      lastError: input.error?.slice(0, 500) ?? null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(scheduleOccurrences.id, input.occurrenceId),
        eq(scheduleOccurrences.status, "queued"),
      ),
    )
    .returning({ scheduleId: scheduleOccurrences.scheduleId });
  if (!row) return false;
  await tx
    .update(taskSchedules)
    .set({
      lastAttemptAt: input.now,
      ...(input.status === "succeeded" ? { lastSuccessAt: input.now } : {}),
      lastErrorCode: input.error?.slice(0, 200) ?? null,
      updatedAt: input.now,
    })
    .where(eq(taskSchedules.id, row.scheduleId));
  return true;
}

/** A task's runs, newest slot first. The cursor is the last row's position. */
export async function listTaskOccurrences(input: {
  scheduleId: string;
  limit: number;
  before?: { scheduledFor: Date; id: string };
}) {
  return db
    .select()
    .from(scheduleOccurrences)
    .where(
      and(
        eq(scheduleOccurrences.scheduleId, input.scheduleId),
        input.before
          ? or(
              lt(scheduleOccurrences.scheduledFor, input.before.scheduledFor),
              and(
                eq(scheduleOccurrences.scheduledFor, input.before.scheduledFor),
                lt(scheduleOccurrences.id, input.before.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(
      desc(scheduleOccurrences.scheduledFor),
      desc(scheduleOccurrences.id),
    )
    .limit(input.limit);
}

/** The slot that started a conversation, and the task its schedule belongs to. */
export async function findOccurrenceByThread(threadId: string) {
  const [row] = await db
    .select({
      occurrence: scheduleOccurrences,
      agentTaskId: taskSchedules.agentTaskId,
    })
    .from(scheduleOccurrences)
    .innerJoin(
      taskSchedules,
      eq(taskSchedules.id, scheduleOccurrences.scheduleId),
    )
    .where(eq(scheduleOccurrences.threadId, threadId))
    .limit(1);
  return row ?? null;
}

/** Blocked tasks whose block has not been looked at since `checkedBefore`. */
export async function listBlockedTasks(input: {
  checkedBefore: Date;
  limit: number;
}): Promise<AgentTaskWithSchedule[]> {
  return joined(db)
    .where(
      and(
        eq(agentTasks.status, "blocked"),
        lt(agentTasks.updatedAt, input.checkedBefore),
      ),
    )
    .orderBy(asc(agentTasks.updatedAt))
    .limit(input.limit);
}

/** Records that a blocked task was looked at and stays blocked. */
export async function touchBlockedTask(taskId: string, now: Date) {
  await db
    .update(agentTasks)
    .set({ updatedAt: now })
    .where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, "blocked")));
}
