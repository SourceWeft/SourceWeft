import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type {
  CreateAgentTaskRequest,
  ScheduleRule,
} from "@sourceweft/contracts/scheduled-tasks";
import type { AgentTaskPorts } from "../modules/agent-tasks";
import type { NotifyInput } from "../modules/notifications";
import type { StartScheduledTurnInput } from "../modules/threads";
import type { TeamAuditEntry } from "../modules/team-audit/types";
import { createRateLimiter } from "../shared/rate-limit";
import { createIsolatedTestDatabase } from "./isolated-database";

/** A Redis that lives in the test, for the fixed-window rate limiter. */
function memoryRedis() {
  const counts = new Map<string, number>();
  return {
    async mget(...keys: string[]) {
      return keys.map((key) =>
        counts.has(key) ? String(counts.get(key)) : null,
      );
    },
    multi() {
      const queued: Array<() => void> = [];
      const pipeline = {
        incr(key: string) {
          queued.push(() => counts.set(key, (counts.get(key) ?? 0) + 1));
          return pipeline;
        },
        expire() {
          return pipeline;
        },
        async exec() {
          queued.forEach((run) => run());
          return queued.map(() => [null, 1] as [Error | null, unknown]);
        },
      };
      return pipeline;
    },
  };
}

/**
 * A migrated database of its own plus the scheduled-task module wired to
 * ports the test controls. Everything that is the module's own (the service,
 * the engine, the SQL) is real; what belongs to other modules (billing, the
 * chat run, notifications, audit) is recorded or scripted here.
 */
export async function createAgentTaskFixture(label: string) {
  const isolated = await createIsolatedTestDatabase(label);
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = isolated.url;
  const schema = await import("@sourceweft/db");
  const tasks = await import("../modules/agent-tasks");
  const { createThreadRecord } =
    await import("../modules/threads/thread/repository");

  const notifications: NotifyInput[] = [];
  const audits: TeamAuditEntry[] = [];
  const started: StartScheduledTurnInput[] = [];
  const stopped: Array<{ threadId: string; idempotencyKey: string }> = [];
  const state = {
    credits: true,
    toolsAvailable: true,
    maxActiveTasks: 10,
    /** Thrown by the next `startTurn` calls, one per call. */
    startErrors: [] as unknown[],
    /** The time of the tick in progress; chat runs are created at it. */
    now: null as Date | null,
  };
  const redis = memoryRedis();
  // One fixed clock, so a test never straddles the end of a rate window.
  const limiterNow = Date.now();
  const limiter = createRateLimiter(
    async () => redis as never,
    () => limiterNow,
  );

  const ports: AgentTaskPorts = {
    hasWorkspaceAccess: tasks.agentTaskPorts.hasWorkspaceAccess,
    resolveBillingTeamId: async ({ teamId }) => teamId,
    hasCredits: async () => state.credits,
    maxActiveTasks: async () => state.maxActiveTasks,
    toolsAvailable: async () => state.toolsAvailable,
    // What `startScheduledTurn` leaves behind, without a queue or a worker:
    // the conversation and a queued chat run, found again on a replay.
    async startTurn(input) {
      started.push(input);
      const error = state.startErrors.shift();
      if (error) throw error;
      const [workspace] = await schema.db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, input.workspaceId));
      const scope = {
        teamId: workspace!.organizationId,
        workspaceId: input.workspaceId,
      };
      const thread = await createThreadRecord({
        id: input.threadId,
        ...scope,
        title: input.title,
        createdBy: input.userId,
        origin: "scheduled",
      });
      await schema.db
        .insert(schema.chatThreadRuns)
        .values({
          id: randomUUID(),
          ...scope,
          threadId: thread.id,
          userId: input.userId,
          idempotencyKey: input.idempotencyKey,
          mode: "send",
          streamKey: `test:${randomUUID()}`,
          status: "queued",
          requestJson: { content: input.content, unattended: true },
          createdAt: state.now ?? new Date(),
        })
        .onConflictDoNothing();
      const [run] = await schema.db
        .select()
        .from(schema.chatThreadRuns)
        .where(
          and(
            eq(schema.chatThreadRuns.workspaceId, input.workspaceId),
            eq(schema.chatThreadRuns.idempotencyKey, input.idempotencyKey),
          ),
        );
      return { thread, run: run! };
    },
    async stopRun(input) {
      stopped.push(input);
      await schema.db
        .update(schema.chatThreadRuns)
        .set({ status: "cancelled", errorCode: "CLIENT_CANCELLED" })
        .where(eq(schema.chatThreadRuns.idempotencyKey, input.idempotencyKey));
    },
    async notify(input) {
      notifications.push(input);
    },
    async audit(entry) {
      audits.push(entry);
    },
    consumeRateLimit: (rules) => limiter.consume(rules),
  };
  const service = new tasks.AgentTaskService(ports);

  /** A workspace and people who can work in it. */
  async function workspace(...members: string[]) {
    const teamId: string = randomUUID();
    const workspaceId: string = randomUUID();
    await schema.db.insert(schema.workspaces).values({
      id: workspaceId,
      organizationId: teamId,
      name: "Scheduled tasks",
      slug: workspaceId,
    });
    for (const userId of members) await join(workspaceId, userId);
    return { teamId, workspaceId };
  }

  async function join(workspaceId: string, userId: string) {
    await schema.db
      .insert(schema.workspaceMemberships)
      .values({ workspaceId, userId, role: "editor", source: "guest" });
  }

  async function leave(workspaceId: string, userId: string) {
    await schema.db
      .delete(schema.workspaceMemberships)
      .where(
        and(
          eq(schema.workspaceMemberships.workspaceId, workspaceId),
          eq(schema.workspaceMemberships.userId, userId),
        ),
      );
  }

  function taskInput(
    overrides: Partial<CreateAgentTaskRequest> = {},
  ): CreateAgentTaskRequest {
    return {
      name: `Task ${randomUUID().slice(0, 8)}`,
      prompt: "Summarize what is new in my sources",
      request: {
        sourceIds: [],
        skillIds: [],
        mcp: { installIds: [] },
        webAccess: false,
      },
      rule: { kind: "cron", expr: "0 * * * *" } as ScheduleRule,
      timezone: "UTC",
      activate: true,
      ...overrides,
    };
  }

  async function taskRow(taskId: string) {
    const [row] = await schema.db
      .select()
      .from(schema.agentTasks)
      .where(eq(schema.agentTasks.id, taskId));
    return row!;
  }

  async function scheduleRow(taskId: string) {
    const [row] = await schema.db
      .select()
      .from(schema.taskSchedules)
      .where(eq(schema.taskSchedules.agentTaskId, taskId));
    return row!;
  }

  /** The task's occurrences, oldest slot first. */
  async function occurrences(taskId: string) {
    const schedule = await scheduleRow(taskId);
    const rows = await schema.db
      .select()
      .from(schema.scheduleOccurrences)
      .where(eq(schema.scheduleOccurrences.scheduleId, schedule.id));
    return rows.sort(
      (a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime(),
    );
  }

  /** Makes the task due as if its schedule had last been looked at `at`. */
  async function setDue(taskId: string, nominal: Date) {
    await schema.db
      .update(schema.taskSchedules)
      .set({
        nextDueAt: new Date(
          nominal.getTime() + tasks.agentTaskOffsetMs(taskId),
        ),
      })
      .where(eq(schema.taskSchedules.agentTaskId, taskId));
  }

  async function setRunStatus(
    chatRunId: string,
    status: "completed" | "failed" | "cancelled" | "waiting_for_approval",
    values: { errorCode?: string | null; createdAt?: Date } = {},
  ) {
    await schema.db
      .update(schema.chatThreadRuns)
      .set({ status, ...values })
      .where(eq(schema.chatThreadRuns.id, chatRunId));
  }

  /** One scheduler tick for the scheduled-task kind, at `now`. */
  async function tick(now: Date) {
    state.now = now;
    await tasks.materializeAgentTaskSlots({ now }, ports);
    for (const item of await tasks.listAgentTaskRunsToReconcile(100, now)) {
      await tasks.reconcileAgentTaskRun(item, ports, now);
    }
    for (const item of await tasks.claimAgentTaskOccurrences({ now })) {
      await tasks.dispatchAgentTaskOccurrence(item, ports, now);
    }
    await tasks.recheckBlockedAgentTasks(now, ports);
  }

  function reset() {
    notifications.length = 0;
    audits.length = 0;
    started.length = 0;
    stopped.length = 0;
    state.credits = true;
    state.toolsAvailable = true;
    state.maxActiveTasks = 10;
    state.startErrors = [];
    state.now = null;
  }

  return {
    schema,
    tasks,
    service,
    ports,
    state,
    notifications,
    audits,
    started,
    stopped,
    workspace,
    join,
    leave,
    taskInput,
    taskRow,
    scheduleRow,
    occurrences,
    setDue,
    setRunStatus,
    tick,
    reset,
    async close() {
      await schema.database.end();
      await isolated.close();
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
    },
  };
}

export type AgentTaskFixture = Awaited<
  ReturnType<typeof createAgentTaskFixture>
>;
