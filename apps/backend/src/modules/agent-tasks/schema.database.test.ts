import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

let schema: typeof import("@sourceweft/db");
let engine: typeof import("../schedules/repository");
// Loaded after DATABASE_URL points at the clone: the module reaches the
// database client through the schedules engine.
let agentTaskScheduleState: typeof import("./schedule").agentTaskScheduleState;
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("agent_tasks");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  engine = await import("../schedules/repository");
  ({ agentTaskScheduleState } = await import("./schedule"));
}, 120_000);

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

/** The violated constraint's name, or null when the statement went through. */
async function violation(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    const cause = (error as { cause?: { constraint?: string; code?: string } })
      .cause;
    return cause?.constraint ?? cause?.code ?? "error";
  }
}

type Tenant = { teamId: string; workspaceId: string };

async function workspace(): Promise<Tenant> {
  const teamId: string = randomUUID();
  const workspaceId: string = randomUUID();
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Agent tasks",
    slug: workspaceId,
  });
  return { teamId, workspaceId };
}

async function task(
  tenant: Tenant,
  overrides: Partial<typeof schema.agentTasks.$inferInsert> = {},
) {
  const row = {
    id: randomUUID() as string,
    ...tenant,
    ownerUserId: "owner-1",
    name: `Task ${randomUUID()}`,
    prompt: "Summarize what changed.",
    requestJson: {
      sourceIds: [],
      skillIds: [],
      mcp: { installIds: [] },
      webAccess: false,
    },
    ...overrides,
  };
  await schema.db.insert(schema.agentTasks).values(row);
  return row;
}

function taskSchedule(
  owner: Awaited<ReturnType<typeof task>>,
  overrides: Partial<typeof schema.taskSchedules.$inferInsert> = {},
) {
  return {
    id: randomUUID(),
    teamId: owner.teamId,
    workspaceId: owner.workspaceId,
    taskKind: "agent_task" as const,
    ownerKind: "user" as const,
    ownerUserId: owner.ownerUserId,
    agentTaskId: owner.id,
    ...agentTaskScheduleState({
      taskId: owner.id,
      rule: { kind: "daily", time: "08:00" },
      timezone: "Asia/Shanghai",
      enabled: true,
      now: new Date(),
    }),
    ...overrides,
  };
}

async function connector(tenant: Tenant) {
  const connectorId = randomUUID();
  await schema.db.insert(schema.sourceConnectors).values({
    id: connectorId,
    ...tenant,
    connectorType: "notion",
    name: connectorId,
  });
  return connectorId;
}

function connectorSchedule(tenant: Tenant, connectorId: string) {
  return {
    id: randomUUID(),
    ...tenant,
    taskKind: "connector_sync" as const,
    ownerKind: "workspace" as const,
    connectorId,
    enabled: true,
    intervalMinutes: 60,
  };
}

async function thread(tenant: Tenant, origin: "user" | "scheduled") {
  const id = randomUUID();
  await schema.db
    .insert(schema.threads)
    .values({ id, ...tenant, title: "Run", origin, createdBy: "owner-1" });
  return id;
}

async function rowsOf(scheduleId: string) {
  return schema.db
    .select()
    .from(schema.scheduleOccurrences)
    .where(eq(schema.scheduleOccurrences.scheduleId, scheduleId));
}

test("a task defaults to a draft with notifications on and a first version", async () => {
  const tenant = await workspace();
  const created = await task(tenant);
  const [row] = await schema.db
    .select()
    .from(schema.agentTasks)
    .where(eq(schema.agentTasks.id, created.id));
  assert.ok(row);
  assert.equal(row.status, "draft");
  assert.equal(row.statusReason, null);
  assert.equal(row.consecutiveFailures, 0);
  assert.equal(row.trialRunAt, null);
  assert.equal(row.notifyOnSuccess, true);
  assert.equal(row.notifyEmail, true);
  assert.equal(row.resultTarget, "new_thread");
  assert.equal(row.version, 1);
  assert.equal(row.archivedAt, null);
  assert.ok(row.statusChangedAt instanceof Date);
  assert.deepEqual(row.requestJson, created.requestJson);
});

test("task columns only accept the documented vocabulary and bounds", async () => {
  const tenant = await workspace();
  const attempt = (overrides: Parameters<typeof task>[1]) =>
    violation(() => task(tenant, overrides));
  assert.equal(
    await attempt({ status: "running" as never }),
    "agent_tasks_status_check",
  );
  assert.equal(
    await attempt({ statusReason: "because" as never }),
    "agent_tasks_status_reason_check",
  );
  assert.equal(
    await attempt({ resultTarget: "existing_thread" as never }),
    "agent_tasks_result_target_check",
  );
  assert.equal(await attempt({ name: "" }), "agent_tasks_name_length_check");
  assert.equal(
    await attempt({ name: "n".repeat(81) }),
    "agent_tasks_name_length_check",
  );
  assert.equal(
    await attempt({ prompt: "" }),
    "agent_tasks_prompt_length_check",
  );
  assert.equal(
    await attempt({ prompt: "p".repeat(20001) }),
    "agent_tasks_prompt_length_check",
  );
  assert.equal(
    await attempt({ requestJson: [] as never }),
    "agent_tasks_request_object_check",
  );
  assert.equal(
    await attempt({ consecutiveFailures: -1 }),
    "agent_tasks_consecutive_failures_check",
  );
  assert.equal(await attempt({ version: 0 }), "agent_tasks_version_check");
  // Every status and reason in the contract is storable.
  for (const status of [
    "draft",
    "active",
    "paused",
    "blocked",
    "completed",
    "archived",
  ] as const)
    assert.equal(await attempt({ status }), null);
  for (const statusReason of [
    "user_paused",
    "owner_left",
    "repeated_failure",
    "insufficient_credits",
    "tools_unavailable",
    "auth_expired",
  ] as const)
    assert.equal(await attempt({ status: "paused", statusReason }), null);
  assert.equal(
    await attempt({ name: "n".repeat(80), prompt: "p".repeat(20000) }),
    null,
  );
});

test("a task must live in a workspace of its own team", async () => {
  const tenant = await workspace();
  const other = await workspace();
  assert.equal(
    await violation(() => task({ ...tenant, teamId: other.teamId })),
    "agent_tasks_workspace_team_fk",
  );
  assert.equal(
    await violation(() => task({ teamId: tenant.teamId, workspaceId: "nope" })),
    "agent_tasks_workspace_team_fk",
  );
});

test("a name is unique per owner and workspace, ignoring case, until archived", async () => {
  const tenant = await workspace();
  const other = await workspace();
  const first = await task(tenant, { name: "Morning digest" });
  assert.equal(
    await violation(() => task(tenant, { name: "MORNING DIGEST" })),
    "agent_tasks_owner_name_uq",
  );
  // Another owner, and another workspace, may reuse it.
  await task(tenant, { name: "Morning digest", ownerUserId: "owner-2" });
  await task(other, { name: "Morning digest" });
  // Archiving frees the name; the archived row keeps it.
  await schema.db
    .update(schema.agentTasks)
    .set({ status: "archived", archivedAt: new Date() })
    .where(eq(schema.agentTasks.id, first.id));
  await task(tenant, { name: "morning digest" });
});

test("the target check accepts connector schedules and task schedules", async () => {
  const tenant = await workspace();
  await schema.db
    .insert(schema.taskSchedules)
    .values(connectorSchedule(tenant, await connector(tenant)));
  const owner = await task(tenant);
  const row = taskSchedule(owner);
  await schema.db.insert(schema.taskSchedules).values(row);
  const [stored] = await schema.db
    .select()
    .from(schema.taskSchedules)
    .where(eq(schema.taskSchedules.id, row.id));
  assert.equal(stored!.agentTaskId, owner.id);
  assert.deepEqual(stored!.specJson, { kind: "daily", time: "08:00" });
  assert.equal(stored!.timezone, "Asia/Shanghai");
  assert.equal(stored!.enabled, true);
  assert.ok(stored!.nextDueAt instanceof Date);
  // A manual rule is a stored, disabled schedule with nothing due.
  const manualOwner = await task(tenant);
  await schema.db.insert(schema.taskSchedules).values(
    taskSchedule(manualOwner, {
      ...agentTaskScheduleState({
        taskId: manualOwner.id,
        rule: { kind: "manual" },
        timezone: "UTC",
        enabled: true,
        now: new Date(),
      }),
    }),
  );
});

test("the target check rejects a schedule that points at both kinds of target", async () => {
  const tenant = await workspace();
  const owner = await task(tenant);
  const connectorId = await connector(tenant);
  const insert = (row: typeof schema.taskSchedules.$inferInsert) =>
    violation(() => schema.db.insert(schema.taskSchedules).values(row));

  // A connector schedule carrying a task.
  assert.equal(
    await insert({
      ...connectorSchedule(tenant, connectorId),
      ownerUserId: owner.ownerUserId,
      agentTaskId: owner.id,
    }),
    "task_schedules_target_check",
  );
  // A task schedule carrying a connector.
  assert.equal(
    await insert(taskSchedule(owner, { connectorId })),
    "task_schedules_target_check",
  );
  // A task schedule owned by the workspace, or by nobody.
  assert.equal(
    await insert(taskSchedule(owner, { ownerKind: "workspace" })),
    "task_schedules_target_check",
  );
  assert.equal(
    await insert(taskSchedule(owner, { ownerUserId: null })),
    "task_schedules_target_check",
  );
  // A connector schedule without its connector, or with a non-positive interval.
  assert.equal(
    await insert({
      ...connectorSchedule(tenant, connectorId),
      connectorId: null,
    }),
    "task_schedules_target_check",
  );
  assert.equal(
    await insert({
      ...connectorSchedule(tenant, connectorId),
      intervalMinutes: 0,
    }),
    "task_schedules_target_check",
  );
  assert.equal(
    await insert({
      ...connectorSchedule(tenant, connectorId),
      taskKind: "report" as never,
    }),
    "task_schedules_kind_check",
  );
});

test("the target check rejects a task schedule without its task", async () => {
  const tenant = await workspace();
  const owner = await task(tenant);
  assert.equal(
    await violation(() =>
      schema.db
        .insert(schema.taskSchedules)
        .values(taskSchedule(owner, { agentTaskId: null })),
    ),
    "task_schedules_target_check",
  );
  // Neither kind of target at all.
  assert.equal(
    await violation(() =>
      schema.db.insert(schema.taskSchedules).values({
        id: randomUUID(),
        ...tenant,
        taskKind: "connector_sync",
        ownerKind: "workspace",
        intervalMinutes: 60,
      }),
    ),
    "task_schedules_target_check",
  );
});

test("an occurrence must carry its tenant keys", async () => {
  const tenant = await workspace();
  const connectorRow = connectorSchedule(tenant, await connector(tenant));
  await schema.db.insert(schema.taskSchedules).values(connectorRow);
  // The shape a scheduler from before the tenant keys existed wrote.
  assert.equal(
    await violation(() =>
      schema.db.execute(
        sql`insert into schedule_occurrences (id, schedule_id, scheduled_for) values (${randomUUID()}, ${connectorRow.id}, ${"2027-01-01T00:00:00Z"})`,
      ),
    ),
    "23502",
  );
  const newShape = randomUUID();
  await schema.db.insert(schema.scheduleOccurrences).values({
    id: newShape,
    scheduleId: connectorRow.id,
    ...tenant,
    scheduledFor: new Date("2027-01-01T01:00:00Z"),
  });
  const rows = await rowsOf(connectorRow.id);
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(rows.length, 1);
  assert.equal(byId.get(newShape)!.teamId, tenant.teamId);
  assert.equal(byId.get(newShape)!.workspaceId, tenant.workspaceId);
  assert.equal(byId.get(newShape)!.status, "pending");
  assert.equal(byId.get(newShape)!.triggerKind, "schedule");
  // It still goes when the schedule's workspace is deleted.
  await schema.db
    .delete(schema.workspaces)
    .where(eq(schema.workspaces.id, tenant.workspaceId));
  assert.equal((await rowsOf(connectorRow.id)).length, 0);
});

test("a schedule can only point at a task with the same workspace, team and owner", async () => {
  const tenant = await workspace();
  const other = await workspace();
  const owner = await task(tenant);
  const insert = (overrides: Parameters<typeof taskSchedule>[1]) =>
    violation(() =>
      schema.db
        .insert(schema.taskSchedules)
        .values(taskSchedule(owner, overrides)),
    );
  assert.equal(
    await insert({ ownerUserId: "someone-else" }),
    "task_schedules_agent_task_owner_fk",
  );
  assert.equal(
    await insert({ teamId: other.teamId, workspaceId: other.workspaceId }),
    "task_schedules_agent_task_owner_fk",
  );
  assert.equal(
    await insert({ agentTaskId: randomUUID() }),
    "task_schedules_agent_task_owner_fk",
  );
  // One schedule per task.
  assert.equal(await insert({}), null);
  assert.equal(await insert({}), "task_schedules_agent_task_uq");
});

test("deleting a task removes its schedule and runs but keeps the conversation", async () => {
  const tenant = await workspace();
  const owner = await task(tenant);
  const row = taskSchedule(owner);
  await schema.db.insert(schema.taskSchedules).values(row);
  const threadId = await thread(tenant, "scheduled");
  await schema.db.insert(schema.scheduleOccurrences).values({
    id: randomUUID(),
    scheduleId: row.id,
    ...tenant,
    scheduledFor: new Date(),
    status: "succeeded",
    threadId,
    taskVersion: 1,
  });
  const untouched = await task(tenant);
  await schema.db.insert(schema.taskSchedules).values(taskSchedule(untouched));

  await schema.db
    .delete(schema.agentTasks)
    .where(eq(schema.agentTasks.id, owner.id));

  assert.equal(
    (
      await schema.db
        .select()
        .from(schema.taskSchedules)
        .where(eq(schema.taskSchedules.id, row.id))
    ).length,
    0,
  );
  assert.equal((await rowsOf(row.id)).length, 0);
  const [kept] = await schema.db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.id, threadId));
  assert.equal(kept!.origin, "scheduled");
  assert.equal(
    (
      await schema.db
        .select()
        .from(schema.taskSchedules)
        .where(eq(schema.taskSchedules.agentTaskId, untouched.id))
    ).length,
    1,
  );
});

test("deleting a workspace removes its tasks, schedules and runs, and no one else's", async () => {
  const tenant = await workspace();
  const other = await workspace();
  const owner = await task(tenant);
  const row = taskSchedule(owner);
  await schema.db.insert(schema.taskSchedules).values(row);
  await schema.db.insert(schema.scheduleOccurrences).values({
    id: randomUUID(),
    scheduleId: row.id,
    ...tenant,
    scheduledFor: new Date(),
  });
  const connectorRow = connectorSchedule(tenant, await connector(tenant));
  await schema.db.insert(schema.taskSchedules).values(connectorRow);
  const otherOwner = await task(other);
  const otherRow = taskSchedule(otherOwner);
  await schema.db.insert(schema.taskSchedules).values(otherRow);

  await schema.db
    .delete(schema.workspaces)
    .where(eq(schema.workspaces.id, tenant.workspaceId));

  assert.equal(
    (
      await schema.db
        .select()
        .from(schema.agentTasks)
        .where(eq(schema.agentTasks.workspaceId, tenant.workspaceId))
    ).length,
    0,
  );
  assert.equal(
    (
      await schema.db
        .select()
        .from(schema.taskSchedules)
        .where(eq(schema.taskSchedules.workspaceId, tenant.workspaceId))
    ).length,
    0,
  );
  assert.equal((await rowsOf(row.id)).length, 0);
  assert.equal(
    (
      await schema.db
        .select()
        .from(schema.taskSchedules)
        .where(eq(schema.taskSchedules.id, otherRow.id))
    ).length,
    1,
  );
});

test("an occurrence records its tenant, trigger, version and links, with safe defaults", async () => {
  const tenant = await workspace();
  const other = await workspace();
  const owner = await task(tenant);
  const row = taskSchedule(owner);
  await schema.db.insert(schema.taskSchedules).values(row);
  const base = () => ({
    id: randomUUID(),
    scheduleId: row.id,
    ...tenant,
    scheduledFor: new Date(Date.now() + Math.floor(Math.random() * 1e9)),
  });
  const insert = (
    overrides: Partial<typeof schema.scheduleOccurrences.$inferInsert>,
  ) =>
    violation(() =>
      schema.db.insert(schema.scheduleOccurrences).values({
        ...base(),
        ...overrides,
      }),
    );

  const plain = base();
  await schema.db.insert(schema.scheduleOccurrences).values(plain);
  const [stored] = await schema.db
    .select()
    .from(schema.scheduleOccurrences)
    .where(eq(schema.scheduleOccurrences.id, plain.id));
  assert.equal(stored!.teamId, tenant.teamId);
  assert.equal(stored!.workspaceId, tenant.workspaceId);
  assert.equal(stored!.status, "pending");
  assert.equal(stored!.triggerKind, "schedule");
  assert.equal(stored!.skipReason, null);
  assert.equal(stored!.chatRunId, null);
  assert.equal(stored!.threadId, null);
  assert.equal(stored!.taskVersion, null);
  assert.equal(stored!.isCatchUp, false);

  // When present, the tenant keys must name a real workspace of that team.
  assert.equal(
    await insert({ teamId: other.teamId }),
    "schedule_occurrences_workspace_team_fk",
  );

  for (const triggerKind of ["schedule", "manual", "api", "event"] as const)
    assert.equal(await insert({ triggerKind }), null);
  assert.equal(
    await insert({ triggerKind: "webhook" as never }),
    "schedule_occurrences_trigger_kind_check",
  );
  assert.equal(
    await insert({ status: "running" as never }),
    "schedule_occurrences_status_check",
  );
  for (const status of ["blocked", "cancelled"] as const)
    assert.equal(await insert({ status }), null);

  // A skip reason is a known code and only sits on a skipped or blocked run.
  for (const skipReason of [
    "missed_platform_down",
    "previous_run_active",
    "user_concurrency_limit",
    "user_daily_cap",
    "insufficient_credits",
    "owner_left",
    "tools_unavailable",
    "auth_expired",
    "rate_limited",
  ] as const)
    assert.equal(await insert({ status: "skipped", skipReason }), null);
  assert.equal(
    await insert({ status: "blocked", skipReason: "insufficient_credits" }),
    null,
  );
  assert.equal(
    await insert({ status: "skipped", skipReason: "overlap" as never }),
    "schedule_occurrences_skip_reason_check",
  );
  assert.equal(
    await insert({ status: "succeeded", skipReason: "rate_limited" }),
    "schedule_occurrences_skip_reason_check",
  );

  assert.equal(await insert({ taskVersion: 3, isCatchUp: true }), null);
  assert.equal(
    await insert({ taskVersion: 0 }),
    "schedule_occurrences_task_version_check",
  );
  // One occurrence per slot still holds.
  assert.equal(
    await insert({ scheduledFor: plain.scheduledFor }),
    "schedule_occurrences_slot_uq",
  );
});

test("a run keeps its history row when its conversation or chat run is deleted", async () => {
  const tenant = await workspace();
  const owner = await task(tenant);
  const row = taskSchedule(owner);
  await schema.db.insert(schema.taskSchedules).values(row);
  const threadId = await thread(tenant, "scheduled");
  const chatRunId = randomUUID();
  await schema.db.insert(schema.chatThreadRuns).values({
    id: chatRunId,
    ...tenant,
    threadId,
    userId: owner.ownerUserId,
    idempotencyKey: chatRunId,
    mode: "send",
    streamKey: chatRunId,
  });
  const occurrenceId = randomUUID();
  await schema.db.insert(schema.scheduleOccurrences).values({
    id: occurrenceId,
    scheduleId: row.id,
    ...tenant,
    scheduledFor: new Date(),
    status: "succeeded",
    triggerKind: "manual",
    chatRunId,
    threadId,
    taskVersion: 2,
  });
  assert.equal(
    await violation(() =>
      schema.db
        .update(schema.scheduleOccurrences)
        .set({ threadId: "missing" })
        .where(eq(schema.scheduleOccurrences.id, occurrenceId)),
    ),
    "schedule_occurrences_thread_id_threads_id_fk",
  );
  assert.equal(
    await violation(() =>
      schema.db
        .update(schema.scheduleOccurrences)
        .set({ chatRunId: "missing" })
        .where(eq(schema.scheduleOccurrences.id, occurrenceId)),
    ),
    "schedule_occurrences_chat_run_id_chat_thread_runs_id_fk",
  );

  // Deleting the conversation takes its chat run with it.
  await schema.db.delete(schema.threads).where(eq(schema.threads.id, threadId));
  const [kept] = await schema.db
    .select()
    .from(schema.scheduleOccurrences)
    .where(eq(schema.scheduleOccurrences.id, occurrenceId));
  assert.ok(kept);
  assert.equal(kept.threadId, null);
  assert.equal(kept.chatRunId, null);
  assert.equal(kept.status, "succeeded");
  assert.equal(kept.taskVersion, 2);
  assert.equal(kept.triggerKind, "manual");
});

test("a thread may be marked as created by a scheduled run", async () => {
  const tenant = await workspace();
  await thread(tenant, "scheduled");
  assert.equal(
    await violation(() => thread(tenant, "cron" as never)),
    "threads_origin_check",
  );
});

test("the engine stamps a materialized occurrence with its schedule's tenant", async () => {
  const tenant = await workspace();
  const now = new Date();
  const connectorRow = {
    ...connectorSchedule(tenant, await connector(tenant)),
    nextDueAt: new Date(now.getTime() - 60_000),
  };
  await schema.db.insert(schema.taskSchedules).values(connectorRow);
  const owner = await task(tenant);
  const taskRow = taskSchedule(owner, {
    enabled: true,
    nextDueAt: new Date(now.getTime() - 60_000),
  });
  await schema.db.insert(schema.taskSchedules).values(taskRow);

  for (const [taskKind, scheduleId] of [
    ["connector_sync", connectorRow.id],
    ["agent_task", taskRow.id],
  ] as const) {
    await engine.materializeDueSchedules({
      taskKind,
      now,
      limit: 100,
      computeSlot: (schedule) =>
        schedule.id === scheduleId
          ? {
              scheduledFor: schedule.nextDueAt!,
              nextDueAt: new Date(now.getTime() + 60 * 60_000),
            }
          : null,
    });
    const rows = await rowsOf(scheduleId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.teamId, tenant.teamId);
    assert.equal(rows[0]!.workspaceId, tenant.workspaceId);
    assert.equal(rows[0]!.triggerKind, "schedule");
    assert.equal(rows[0]!.isCatchUp, false);
  }
});
