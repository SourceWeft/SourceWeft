import { randomUUID } from "node:crypto";
import {
  agentTaskRequestSchema,
  type AgentTask,
  type AgentTaskRun,
  type CreateAgentTaskRequest,
  type ListAgentTaskRunsRequest,
  type PreviewAgentTaskScheduleRequest,
  type RunAgentTaskNowRequest,
  type ScheduleRule,
  type UpdateAgentTaskRequest,
} from "@sourceweft/contracts/scheduled-tasks";
import { db } from "@sourceweft/db";
import { AgentTaskError } from "./errors";
import { ScheduleRuleError, type ScheduleTx } from "../schedules";
import { requireContentWorkspace } from "../workspace/guards";
import {
  AGENT_TASK_RUN_NOW_PER_TASK_PER_HOUR,
  AGENT_TASK_RUN_NOW_PER_USER_PER_HOUR,
} from "./limits";
import { agentTaskPorts, type AgentTaskPorts } from "./ports";
import {
  cancelPendingOccurrences,
  countActiveTasks,
  countOccurrences,
  deleteTaskRow,
  findOccurrence,
  findOccurrenceByThread,
  findOwnedTask,
  insertManualOccurrence,
  insertTask,
  listOwnedTasks,
  listTaskOccurrences,
  lockOwnerTasks,
  setTaskStatus,
  uniqueViolation,
  updateScheduleState,
  updateTaskRow,
  type AgentTaskOccurrenceRow,
  type AgentTaskRow,
  type AgentTaskWithSchedule,
} from "./repository";
import {
  RUN_NOW_STATUSES,
  deterministicId,
  dispatchAgentTaskOccurrence,
} from "./runs";
import {
  agentTaskRule,
  agentTaskScheduleState,
  assertAgentTaskSchedule,
  previewAgentTaskSchedule,
} from "./schedule";

const DEFAULT_RUNS_PAGE = 20;
const TASK_NAME_CONSTRAINT = "agent_tasks_owner_name_uq";

/** Who is asking, and in which workspace. Both come from the session and the
 * route, and both are part of every lookup. */
type Caller = { workspaceId: string; userId: string };

function presentTask({ task, schedule }: AgentTaskWithSchedule): AgentTask {
  return {
    id: task.id,
    teamId: task.teamId,
    workspaceId: task.workspaceId,
    ownerUserId: task.ownerUserId,
    name: task.name,
    prompt: task.prompt,
    request: agentTaskRequestSchema.parse(task.requestJson),
    schedule: {
      rule: agentTaskRule(schedule),
      timezone: schedule.timezone,
      enabled: schedule.enabled,
      nextDueAt: schedule.nextDueAt?.toISOString() ?? null,
    },
    status: task.status,
    statusReason: task.statusReason,
    statusChangedAt: task.statusChangedAt.toISOString(),
    consecutiveFailures: task.consecutiveFailures,
    trialRunAt: task.trialRunAt?.toISOString() ?? null,
    notifyOnSuccess: task.notifyOnSuccess,
    notifyEmail: task.notifyEmail,
    resultTarget: task.resultTarget,
    version: task.version,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    archivedAt: task.archivedAt?.toISOString() ?? null,
  };
}

function presentRun(taskId: string, row: AgentTaskOccurrenceRow): AgentTaskRun {
  return {
    id: row.id,
    taskId,
    scheduledFor: row.scheduledFor.toISOString(),
    status: row.status,
    triggerKind: row.triggerKind,
    skipReason: row.skipReason,
    detail:
      row.lastError === "run_timeout"
        ? "timed_out"
        : row.lastError === "approval_requested"
          ? "needs_approval"
          : null,
    taskVersion: row.taskVersion,
    isCatchUp: row.isCatchUp,
    threadId: row.threadId,
    chatRunId: row.chatRunId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function notFound() {
  return new AgentTaskError(404, "AGENT_TASK_NOT_FOUND", "Task not found");
}

/** A rule the task may not have, as a 400 that names why. */
function assertRule(rule: ScheduleRule, timezone: string, now: Date) {
  try {
    assertAgentTaskSchedule(rule, timezone, now);
  } catch (error) {
    if (error instanceof ScheduleRuleError) {
      throw new AgentTaskError(
        400,
        "AGENT_TASK_SCHEDULE_INVALID",
        error.message,
        { reason: error.code },
      );
    }
    throw error;
  }
}

function nameTaken(error: unknown) {
  return uniqueViolation(error) === TASK_NAME_CONSTRAINT
    ? new AgentTaskError(
        409,
        "AGENT_TASK_NAME_TAKEN",
        "You already have a task with this name in this workspace",
      )
    : error;
}

function encodeRunsCursor(row: AgentTaskOccurrenceRow) {
  return Buffer.from(
    `${row.scheduledFor.getTime()}.${row.id}`,
    "utf8",
  ).toString("base64url");
}

function decodeRunsCursor(cursor: string) {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf(".");
  const ms = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (separator < 1 || !Number.isFinite(ms) || !id) {
    throw new AgentTaskError(400, "VALIDATION_ERROR", "Invalid cursor");
  }
  return { scheduledFor: new Date(ms), id };
}

export class AgentTaskService {
  constructor(private readonly ports: AgentTaskPorts = agentTaskPorts) {}

  /**
   * The caller's own task in the caller's workspace, or a 404. Somebody
   * else's task, and a task in another workspace, do not exist as far as the
   * caller can tell. The team is never taken from the request: it is the
   * stored row's.
   */
  private async requireTask(
    caller: Caller,
    taskId: string,
    options: { tx?: ScheduleTx; allowArchived?: boolean } = {},
  ) {
    const found = await findOwnedTask(
      { taskId, ownerUserId: caller.userId, workspaceId: caller.workspaceId },
      options.tx ?? db,
      { forUpdate: Boolean(options.tx) },
    );
    if (!found) throw notFound();
    if (found.task.archivedAt && !options.allowArchived) {
      throw new AgentTaskError(
        409,
        "AGENT_TASK_ARCHIVED",
        "This task has been deleted",
      );
    }
    return found;
  }

  /**
   * Refuses one more active task than the owner's plan allows. Called with
   * the owner's tasks locked, so two requests cannot both squeeze in.
   */
  private async assertBelowPlanLimit(
    tx: ScheduleTx,
    task: Pick<AgentTaskRow, "teamId" | "workspaceId" | "ownerUserId"> & {
      id?: string;
    },
  ) {
    const billingTeamId = await this.ports.resolveBillingTeamId({
      workspaceId: task.workspaceId,
      teamId: task.teamId,
      userId: task.ownerUserId,
    });
    const limit = await this.ports.maxActiveTasks({
      teamId: billingTeamId,
      userId: task.ownerUserId,
    });
    const active = await countActiveTasks(tx, {
      teamId: task.teamId,
      ownerUserId: task.ownerUserId,
      excludeTaskId: task.id,
    });
    if (active >= limit) {
      throw new AgentTaskError(
        409,
        "AGENT_TASK_LIMIT_REACHED",
        `Your plan allows ${limit} active scheduled tasks`,
        { limit, active },
      );
    }
  }

  async createTask(caller: Caller, input: CreateAgentTaskRequest) {
    const workspace = await requireContentWorkspace(caller);
    const now = new Date();
    assertRule(input.rule, input.timezone, now);
    const id = randomUUID();
    const scope = {
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      ownerUserId: caller.userId,
    };
    const created = await db
      .transaction(async (tx) => {
        if (input.activate) {
          await lockOwnerTasks(tx, caller.userId);
          await this.assertBelowPlanLimit(tx, scope);
        }
        return insertTask(tx, {
          id,
          ...scope,
          name: input.name,
          prompt: input.prompt,
          request: input.request,
          status: input.activate ? "active" : "draft",
          notifyOnSuccess: input.notifyOnSuccess,
          notifyEmail: input.notifyEmail,
          schedule: agentTaskScheduleState({
            taskId: id,
            rule: input.rule,
            timezone: input.timezone,
            enabled: input.activate,
            now,
          }),
          now,
        });
      })
      .catch((error: unknown) => {
        throw nameTaken(error);
      });
    await this.ports.audit({
      teamId: scope.teamId,
      actorUserId: caller.userId,
      action: "agent_task.created",
      targetType: "agent_task",
      targetId: id,
      metadata: {
        workspaceId: scope.workspaceId,
        status: created.task.status,
        rule: input.rule.kind,
      },
    });
    return { task: presentTask(created) };
  }

  async listTasks(caller: Caller) {
    const workspace = await requireContentWorkspace(caller);
    const rows = await listOwnedTasks({
      workspaceId: workspace.id,
      ownerUserId: caller.userId,
    });
    return { tasks: rows.map(presentTask) };
  }

  async getTask(caller: Caller, taskId: string) {
    await requireContentWorkspace(caller);
    return {
      task: presentTask(
        await this.requireTask(caller, taskId, { allowArchived: true }),
      ),
    };
  }

  /**
   * Edits a task against the version the editor saw. The version moves when
   * what a run does or when it runs changes (prompt, request, rule, time
   * zone), so every run can be traced to the text that produced it.
   */
  async updateTask(
    caller: Caller,
    taskId: string,
    input: UpdateAgentTaskRequest,
  ) {
    await requireContentWorkspace(caller);
    const now = new Date();
    const changed: string[] = [];
    const updated = await db
      .transaction(async (tx) => {
        const current = await this.requireTask(caller, taskId, { tx });
        const { task, schedule } = current;
        if (task.version !== input.version) {
          throw new AgentTaskError(
            409,
            "AGENT_TASK_VERSION_CONFLICT",
            "This task was changed somewhere else. Reload it and try again.",
            { version: task.version },
          );
        }
        const rule = input.rule ?? agentTaskRule(schedule);
        const timezone = input.timezone ?? schedule.timezone;
        const ruleChanged =
          JSON.stringify(rule) !== JSON.stringify(agentTaskRule(schedule)) ||
          timezone !== schedule.timezone;
        const runChanged =
          (input.prompt !== undefined && input.prompt !== task.prompt) ||
          (input.request !== undefined &&
            JSON.stringify(input.request) !== JSON.stringify(task.requestJson));
        if (ruleChanged) assertRule(rule, timezone, now);

        for (const key of [
          "name",
          "prompt",
          "request",
          "notifyOnSuccess",
          "notifyEmail",
        ] as const) {
          if (input[key] !== undefined) changed.push(key);
        }
        if (ruleChanged) changed.push("schedule");

        const nextTask = await updateTaskRow(tx, task.id, {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
          ...(input.request === undefined
            ? {}
            : { requestJson: input.request }),
          ...(input.notifyOnSuccess === undefined
            ? {}
            : { notifyOnSuccess: input.notifyOnSuccess }),
          ...(input.notifyEmail === undefined
            ? {}
            : { notifyEmail: input.notifyEmail }),
          version: task.version + (ruleChanged || runChanged ? 1 : 0),
          updatedAt: now,
        });
        if (!ruleChanged) return { task: nextTask, schedule };
        // Slots of the old rule that have not started are not the new rule's.
        await cancelPendingOccurrences(tx, schedule.id, now);
        return {
          task: nextTask,
          schedule: await updateScheduleState(
            tx,
            schedule.id,
            agentTaskScheduleState({
              taskId: task.id,
              rule,
              timezone,
              enabled: task.status === "active",
              now,
            }),
            now,
          ),
        };
      })
      .catch((error: unknown) => {
        throw nameTaken(error);
      });
    await this.ports.audit({
      teamId: updated.task.teamId,
      actorUserId: caller.userId,
      action: "agent_task.updated",
      targetType: "agent_task",
      targetId: taskId,
      metadata: { changed, version: updated.task.version },
    });
    return { task: presentTask(updated) };
  }

  /** Enables a task from now on. Nothing before now is made up for. */
  private async enable(
    caller: Caller,
    taskId: string,
    from: ReadonlyArray<AgentTaskRow["status"]>,
    action: "agent_task.activated" | "agent_task.resumed",
  ) {
    await requireContentWorkspace(caller);
    const now = new Date();
    const enabled = await db.transaction(async (tx) => {
      await lockOwnerTasks(tx, caller.userId);
      const { task, schedule } = await this.requireTask(caller, taskId, { tx });
      if (!from.includes(task.status)) {
        throw new AgentTaskError(
          409,
          "AGENT_TASK_INVALID_STATE",
          `A task that is ${task.status} cannot be enabled this way`,
          { status: task.status },
        );
      }
      const rule = agentTaskRule(schedule);
      assertRule(rule, schedule.timezone, now);
      await this.assertBelowPlanLimit(tx, task);
      return setTaskStatus(tx, {
        taskId: task.id,
        scheduleId: schedule.id,
        status: "active",
        reason: null,
        schedule: agentTaskScheduleState({
          taskId: task.id,
          rule,
          timezone: schedule.timezone,
          enabled: true,
          now,
        }),
        now,
        extra: { consecutiveFailures: 0 },
      });
    });
    await this.ports.audit({
      teamId: enabled.task.teamId,
      actorUserId: caller.userId,
      action,
      targetType: "agent_task",
      targetId: taskId,
    });
    return { task: presentTask(enabled) };
  }

  /** Turns a draft, or a one-time task that has run, into an active task. */
  activateTask(caller: Caller, taskId: string) {
    return this.enable(
      caller,
      taskId,
      ["draft", "completed"],
      "agent_task.activated",
    );
  }

  resumeTask(caller: Caller, taskId: string) {
    return this.enable(caller, taskId, ["paused"], "agent_task.resumed");
  }

  /** Stops future runs. A run already going is left to finish. */
  async pauseTask(caller: Caller, taskId: string) {
    await requireContentWorkspace(caller);
    const now = new Date();
    const paused = await db.transaction(async (tx) => {
      const { task, schedule } = await this.requireTask(caller, taskId, { tx });
      if (task.status !== "active" && task.status !== "blocked") {
        throw new AgentTaskError(
          409,
          "AGENT_TASK_INVALID_STATE",
          `A task that is ${task.status} cannot be paused`,
          { status: task.status },
        );
      }
      await cancelPendingOccurrences(tx, schedule.id, now);
      return setTaskStatus(tx, {
        taskId: task.id,
        scheduleId: schedule.id,
        status: "paused",
        reason: "user_paused",
        schedule: { enabled: false, nextDueAt: null },
        now,
      });
    });
    await this.ports.audit({
      teamId: paused.task.teamId,
      actorUserId: caller.userId,
      action: "agent_task.paused",
      targetType: "agent_task",
      targetId: taskId,
      metadata: { reason: "user_paused" },
    });
    return { task: presentTask(paused) };
  }

  /**
   * Deletes a task. One that has run is archived so its history and the
   * conversations it produced stay; a draft that never ran is removed.
   */
  async deleteTask(caller: Caller, taskId: string) {
    await requireContentWorkspace(caller);
    const now = new Date();
    const teamId = await db.transaction(async (tx) => {
      const { task, schedule } = await this.requireTask(caller, taskId, {
        tx,
        allowArchived: true,
      });
      if (task.archivedAt) return task.teamId;
      if (
        task.status === "draft" &&
        (await countOccurrences(tx, schedule.id)) === 0
      ) {
        await deleteTaskRow(tx, task.id);
        return task.teamId;
      }
      await cancelPendingOccurrences(tx, schedule.id, now);
      await setTaskStatus(tx, {
        taskId: task.id,
        scheduleId: schedule.id,
        status: "archived",
        reason: null,
        schedule: { enabled: false, nextDueAt: null },
        now,
        extra: { archivedAt: now },
      });
      return task.teamId;
    });
    await this.ports.audit({
      teamId,
      actorUserId: caller.userId,
      action: "agent_task.deleted",
      targetType: "agent_task",
      targetId: taskId,
    });
    return { deleted: true as const };
  }

  /**
   * Starts one run now, whatever the time rule says and without moving it.
   * The same click (same key) is the same run. The run goes through exactly
   * what a scheduled one does: the same checks, the same tool policy, the
   * same billing, and it counts toward the daily cap.
   */
  async runTaskNow(
    caller: Caller,
    taskId: string,
    input: RunAgentTaskNowRequest,
  ) {
    await requireContentWorkspace(caller);
    const { task, schedule } = await this.requireTask(caller, taskId);
    const occurrenceId = deterministicId(
      "agent-task-run-now",
      task.id,
      input.idempotencyKey,
    );
    const replayed = await findOccurrence(occurrenceId);
    if (replayed) return { run: presentRun(task.id, replayed), created: false };

    if (!RUN_NOW_STATUSES.includes(task.status)) {
      throw new AgentTaskError(
        409,
        "AGENT_TASK_INVALID_STATE",
        `A task that is ${task.status} cannot be run`,
        { status: task.status },
      );
    }
    const verdict = await this.ports.consumeRateLimit([
      {
        key: `agent-task-run-now:task:${task.id}`,
        limit: AGENT_TASK_RUN_NOW_PER_TASK_PER_HOUR,
        windowSeconds: 3600,
        scope: "task",
      },
      {
        key: `agent-task-run-now:user:${caller.userId}`,
        limit: AGENT_TASK_RUN_NOW_PER_USER_PER_HOUR,
        windowSeconds: 3600,
        scope: "user",
      },
    ]);
    if (!verdict.allowed) {
      throw new AgentTaskError(
        429,
        "AGENT_TASK_RUN_RATE_LIMITED",
        "This task was run too many times in the last hour. Try again later.",
        {
          scope: verdict.scope,
          limit: verdict.limit,
          retryAfterSeconds: verdict.retryAfterSeconds,
        },
      );
    }

    const now = new Date();
    const occurrence = await insertManualOccurrence({
      id: occurrenceId,
      schedule,
      now,
    });
    if (!occurrence) {
      // The same click arrived twice at once; the other request owns the run.
      const other = await findOccurrence(occurrenceId);
      if (other) return { run: presentRun(task.id, other), created: false };
      throw new AgentTaskError(
        409,
        "AGENT_TASK_RUN_CONFLICT",
        "Another run of this task started at the same moment. Try again.",
      );
    }
    await this.ports.audit({
      teamId: task.teamId,
      actorUserId: caller.userId,
      action: "agent_task.run_requested",
      targetType: "agent_task",
      targetId: task.id,
      metadata: { runId: occurrenceId },
    });
    // The slot is leased to this request. If the process dies before it is
    // settled, the scheduler picks it up when the lease runs out.
    await dispatchAgentTaskOccurrence(
      { occurrence: { ...occurrence, attempts: 0 }, schedule },
      this.ports,
      now,
    );
    return {
      run: presentRun(task.id, (await findOccurrence(occurrenceId))!),
      created: true,
    };
  }

  async listTaskRuns(
    caller: Caller,
    taskId: string,
    input: ListAgentTaskRunsRequest,
  ) {
    await requireContentWorkspace(caller);
    const { task, schedule } = await this.requireTask(caller, taskId, {
      allowArchived: true,
    });
    const limit = input.limit ?? DEFAULT_RUNS_PAGE;
    const rows = await listTaskOccurrences({
      scheduleId: schedule.id,
      limit: limit + 1,
      before: input.cursor ? decodeRunsCursor(input.cursor) : undefined,
    });
    const page = rows.slice(0, limit);
    return {
      runs: page.map((row) => presentRun(task.id, row)),
      nextCursor:
        rows.length > limit ? encodeRunsCursor(page[page.length - 1]!) : null,
    };
  }

  /**
   * The scheduled run that created a conversation, for the notice a person
   * sees at the top of it. Only the task's owner finds it; any other
   * conversation, or somebody else's, is a 404.
   */
  async findRunForThread(caller: Caller, threadId: string) {
    await requireContentWorkspace(caller);
    const found = await findOccurrenceByThread(threadId);
    if (!found?.agentTaskId) throw notFound();
    const owned = await findOwnedTask({
      taskId: found.agentTaskId,
      ownerUserId: caller.userId,
      workspaceId: caller.workspaceId,
    });
    if (!owned) throw notFound();
    return {
      run: presentRun(owned.task.id, found.occurrence),
      task: { id: owned.task.id, name: owned.task.name },
    };
  }

  /** The next fire times of a rule, for a form, before anything is saved. */
  async previewSchedule(
    caller: Caller,
    input: PreviewAgentTaskScheduleRequest,
  ) {
    await requireContentWorkspace(caller);
    const now = new Date();
    assertRule(input.rule, input.timezone, now);
    return previewAgentTaskSchedule({ ...input, now });
  }
}

export const agentTaskService = new AgentTaskService();
