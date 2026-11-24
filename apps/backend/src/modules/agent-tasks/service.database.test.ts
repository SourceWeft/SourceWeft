import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import {
  createAgentTaskFixture,
  type AgentTaskFixture,
} from "../../test/agent-task-fixture";

let f: AgentTaskFixture;

beforeAll(async () => {
  f = await createAgentTaskFixture("agent_task_svc");
}, 120_000);

beforeEach(() => f.reset());

afterAll(async () => {
  await f?.close();
});

/** The error code a rejected call carries, or null when it went through. */
async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    const { statusCode, code } = error as {
      statusCode?: number;
      code?: string;
    };
    return `${statusCode} ${code}`;
  }
}

async function ownerAndWorkspace() {
  const owner = randomUUID();
  const tenant = await f.workspace(owner);
  return {
    owner,
    ...tenant,
    caller: { workspaceId: tenant.workspaceId, userId: owner },
  };
}

test("a task is created as a draft for its creator, in the workspace's own team", async () => {
  const { owner, teamId, workspaceId, caller } = await ownerAndWorkspace();
  const { task } = await f.service.createTask(
    caller,
    f.taskInput({ activate: false, rule: { kind: "daily", time: "08:00" } }),
  );
  assert.equal(task.status, "draft");
  assert.equal(task.ownerUserId, owner);
  assert.equal(task.teamId, teamId);
  assert.equal(task.workspaceId, workspaceId);
  assert.equal(task.version, 1);
  assert.deepEqual(task.schedule, {
    rule: { kind: "daily", time: "08:00" },
    timezone: "UTC",
    enabled: false,
    nextDueAt: null,
  });
  assert.deepEqual(
    f.audits.map((entry) => [entry.action, entry.actorUserId, entry.teamId]),
    [["agent_task.created", owner, teamId]],
  );
  assert.deepEqual(
    (await f.service.listTasks(caller)).tasks.map((item) => item.id),
    [task.id],
  );
  assert.equal((await f.service.getTask(caller, task.id)).task.id, task.id);
});

test("an active task is due at its next fire time plus its fixed offset, never in the past", async () => {
  const { caller } = await ownerAndWorkspace();
  const before = Date.now();
  const { task } = await f.service.createTask(caller, f.taskInput());
  assert.equal(task.status, "active");
  assert.equal(task.schedule.enabled, true);
  const due = new Date(task.schedule.nextDueAt!).getTime();
  const offset = f.tasks.agentTaskOffsetMs(task.id);
  assert.ok(due > before);
  assert.equal((due - offset) % (60 * 60_000), 0);
});

test("every route's operation answers 404 for somebody else's task, and for the owner in another workspace", async () => {
  const { owner, workspaceId, caller } = await ownerAndWorkspace();
  const colleague = randomUUID();
  await f.join(workspaceId, colleague);
  const elsewhere = await f.workspace(owner, colleague);
  const { task } = await f.service.createTask(caller, f.taskInput());

  const operations = (who: { workspaceId: string; userId: string }) => ({
    get: () => f.service.getTask(who, task.id),
    update: () =>
      f.service.updateTask(who, task.id, { version: 1, name: "Mine now" }),
    delete: () => f.service.deleteTask(who, task.id),
    pause: () => f.service.pauseTask(who, task.id),
    resume: () => f.service.resumeTask(who, task.id),
    activate: () => f.service.activateTask(who, task.id),
    runNow: () =>
      f.service.runTaskNow(who, task.id, { idempotencyKey: randomUUID() }),
    runs: () => f.service.listTaskRuns(who, task.id, {}),
  });

  // A colleague in the same workspace, the same colleague through another
  // workspace, and the owner naming a workspace the task is not in.
  for (const who of [
    { workspaceId, userId: colleague },
    { workspaceId: elsewhere.workspaceId, userId: colleague },
    { workspaceId: elsewhere.workspaceId, userId: owner },
  ]) {
    for (const [name, run] of Object.entries(operations(who))) {
      assert.equal(await refusal(run), "404 AGENT_TASK_NOT_FOUND", name);
    }
    assert.deepEqual((await f.service.listTasks(who)).tasks, []);
  }

  // Someone who cannot enter the workspace at all learns nothing about it.
  const outsider = { workspaceId, userId: randomUUID() };
  for (const [name, run] of Object.entries(operations(outsider))) {
    assert.equal(await refusal(run), "404 WORKSPACE_NOT_FOUND", name);
  }
  assert.equal(
    await refusal(() => f.service.listTasks(outsider)),
    "404 WORKSPACE_NOT_FOUND",
  );
  assert.equal(
    await refusal(() => f.service.createTask(outsider, f.taskInput())),
    "404 WORKSPACE_NOT_FOUND",
  );
  assert.equal(
    await refusal(() =>
      f.service.previewSchedule(outsider, {
        rule: { kind: "daily", time: "08:00" },
        timezone: "UTC",
      }),
    ),
    "404 WORKSPACE_NOT_FOUND",
  );

  // Nothing above touched the task or started a run.
  const row = await f.taskRow(task.id);
  assert.equal(row.name, task.name);
  assert.equal(row.status, "active");
  assert.equal(row.ownerUserId, owner);
  assert.equal(f.started.length, 0);
});

test("editing what a run does or when it runs moves the version; a rename does not; a stale edit is refused", async () => {
  const { caller } = await ownerAndWorkspace();
  const { task } = await f.service.createTask(caller, f.taskInput());

  const renamed = await f.service.updateTask(caller, task.id, {
    version: 1,
    name: "Renamed",
    notifyOnSuccess: false,
  });
  assert.equal(renamed.task.version, 1);
  assert.equal(renamed.task.name, "Renamed");
  assert.equal(renamed.task.notifyOnSuccess, false);

  const reworded = await f.service.updateTask(caller, task.id, {
    version: 1,
    prompt: "List three new points",
  });
  assert.equal(reworded.task.version, 2);

  assert.equal(
    await refusal(() =>
      f.service.updateTask(caller, task.id, { version: 1, prompt: "Stale" }),
    ),
    "409 AGENT_TASK_VERSION_CONFLICT",
  );

  const rescheduled = await f.service.updateTask(caller, task.id, {
    version: 2,
    rule: { kind: "daily", time: "09:30" },
    timezone: "Asia/Shanghai",
  });
  assert.equal(rescheduled.task.version, 3);
  assert.deepEqual(rescheduled.task.schedule.rule, {
    kind: "daily",
    time: "09:30",
  });
  // 09:30 in Shanghai is 01:30 UTC.
  const due = new Date(rescheduled.task.schedule.nextDueAt!);
  const nominal = new Date(due.getTime() - f.tasks.agentTaskOffsetMs(task.id));
  assert.equal(nominal.toISOString().slice(11, 16), "01:30");
  assert.ok(due.getTime() > Date.now());

  assert.deepEqual(
    f.audits
      .filter((entry) => entry.action === "agent_task.updated")
      .map((entry) => entry.metadata),
    [
      { changed: ["name", "notifyOnSuccess"], version: 1 },
      { changed: ["prompt"], version: 2 },
      { changed: ["schedule"], version: 3 },
    ],
  );
});

test("a run records the task version that produced it", async () => {
  const { caller } = await ownerAndWorkspace();
  const { task } = await f.service.createTask(
    caller,
    f.taskInput({ activate: false }),
  );
  const first = await f.service.runTaskNow(caller, task.id, {
    idempotencyKey: "one",
  });
  assert.equal(first.run.taskVersion, 1);
  await f.setRunStatus(first.run.chatRunId!, "completed");
  await f.tick(new Date());

  await f.service.updateTask(caller, task.id, {
    version: 1,
    prompt: "A new prompt",
  });
  const second = await f.service.runTaskNow(caller, task.id, {
    idempotencyKey: "two",
  });
  assert.equal(second.run.taskVersion, 2);
  assert.deepEqual(
    f.started.map((turn) => turn.content),
    ["Summarize what is new in my sources", "A new prompt"],
  );
});

test("a rule that fires more often than hourly is refused on create, edit and preview", async () => {
  const { caller } = await ownerAndWorkspace();
  const tooOften = { kind: "cron", expr: "*/30 * * * *" } as const;
  assert.equal(
    await refusal(() =>
      f.service.createTask(caller, f.taskInput({ rule: tooOften })),
    ),
    "400 AGENT_TASK_SCHEDULE_INVALID",
  );
  const { task } = await f.service.createTask(caller, f.taskInput());
  try {
    await f.service.updateTask(caller, task.id, { version: 1, rule: tooOften });
    assert.fail("expected a refusal");
  } catch (error) {
    assert.deepEqual((error as { details?: unknown }).details, {
      reason: "interval_too_short",
    });
  }
  assert.equal(
    await refusal(() =>
      f.service.previewSchedule(caller, { rule: tooOften, timezone: "UTC" }),
    ),
    "400 AGENT_TASK_SCHEDULE_INVALID",
  );
  const preview = await f.service.previewSchedule(caller, {
    rule: { kind: "cron", expr: "0 * * * *" },
    timezone: "UTC",
  });
  assert.equal(preview.fireTimes.length, 5);
  assert.equal((await f.taskRow(task.id)).version, 1);
});

test("the plan's limit of active tasks holds on create, activate and resume, and pausing frees a place", async () => {
  const { caller } = await ownerAndWorkspace();
  f.state.maxActiveTasks = 2;
  const first = await f.service.createTask(caller, f.taskInput());
  await f.service.createTask(caller, f.taskInput());
  assert.equal(
    await refusal(() => f.service.createTask(caller, f.taskInput())),
    "409 AGENT_TASK_LIMIT_REACHED",
  );
  // A draft is not active, so it can always be saved.
  const draft = await f.service.createTask(
    caller,
    f.taskInput({ activate: false }),
  );
  assert.equal(
    await refusal(() => f.service.activateTask(caller, draft.task.id)),
    "409 AGENT_TASK_LIMIT_REACHED",
  );

  await f.service.pauseTask(caller, first.task.id);
  assert.equal(
    (await f.service.activateTask(caller, draft.task.id)).task.status,
    "active",
  );
  assert.equal(
    await refusal(() => f.service.resumeTask(caller, first.task.id)),
    "409 AGENT_TASK_LIMIT_REACHED",
  );

  // Two requests at once cannot both take the last place.
  f.state.maxActiveTasks = 3;
  const results = await Promise.all(
    [1, 2].map(() =>
      refusal(() => f.service.createTask(caller, f.taskInput())),
    ),
  );
  assert.deepEqual(
    results.sort(),
    ["409 AGENT_TASK_LIMIT_REACHED", null].sort(),
  );

  // Another person's tasks do not count against this one.
  const other = randomUUID();
  await f.join(caller.workspaceId, other);
  assert.equal(
    await refusal(() =>
      f.service.createTask(
        { workspaceId: caller.workspaceId, userId: other },
        f.taskInput(),
      ),
    ),
    null,
  );
});

test("pausing stops the schedule and resuming starts from the next slot without making up for the gap", async () => {
  const { caller } = await ownerAndWorkspace();
  const { task } = await f.service.createTask(caller, f.taskInput());

  const paused = await f.service.pauseTask(caller, task.id);
  assert.equal(paused.task.status, "paused");
  assert.equal(paused.task.statusReason, "user_paused");
  assert.deepEqual(
    [paused.task.schedule.enabled, paused.task.schedule.nextDueAt],
    [false, null],
  );
  assert.equal(
    await refusal(() => f.service.pauseTask(caller, task.id)),
    "409 AGENT_TASK_INVALID_STATE",
  );

  // Hours pass while it is paused: no slot appears.
  await f.tick(new Date(Date.now() + 5 * 60 * 60_000));
  assert.deepEqual(await f.occurrences(task.id), []);

  const resumed = await f.service.resumeTask(caller, task.id);
  assert.equal(resumed.task.status, "active");
  assert.equal(resumed.task.statusReason, null);
  assert.ok(new Date(resumed.task.schedule.nextDueAt!).getTime() > Date.now());
  await f.tick(new Date());
  assert.deepEqual(await f.occurrences(task.id), []);
  assert.equal(
    await refusal(() => f.service.activateTask(caller, task.id)),
    "409 AGENT_TASK_INVALID_STATE",
  );
});

test("run now starts a manual run on a draft, once per click, without moving the schedule", async () => {
  const { caller } = await ownerAndWorkspace();
  const { task } = await f.service.createTask(caller, f.taskInput());
  const dueBefore = (await f.scheduleRow(task.id)).nextDueAt;

  const first = await f.service.runTaskNow(caller, task.id, {
    idempotencyKey: "click",
  });
  assert.equal(first.created, true);
  assert.equal(first.run.status, "queued");
  assert.equal(first.run.triggerKind, "manual");
  assert.ok(first.run.threadId && first.run.chatRunId);

  const again = await f.service.runTaskNow(caller, task.id, {
    idempotencyKey: "click",
  });
  assert.equal(again.created, false);
  assert.equal(again.run.id, first.run.id);
  assert.equal(f.started.length, 1);
  assert.deepEqual((await f.scheduleRow(task.id)).nextDueAt, dueBefore);

  const [turn] = f.started;
  assert.equal(turn!.userId, caller.userId);
  assert.equal(turn!.workspaceId, caller.workspaceId);
  assert.ok(turn!.title.startsWith(`${task.name} · `));

  const { runs } = await f.service.listTaskRuns(caller, task.id, {});
  assert.deepEqual(
    runs.map((run) => run.id),
    [first.run.id],
  );

  // The conversation leads back to its run and task, for its owner only.
  const behind = await f.service.findRunForThread(caller, first.run.threadId!);
  assert.equal(behind.run.id, first.run.id);
  assert.equal(behind.task.name, task.name);
  assert.equal(behind.run.detail, null);
  assert.equal(
    await refusal(() => f.service.findRunForThread(caller, randomUUID())),
    "404 AGENT_TASK_NOT_FOUND",
  );

  // A draft can be tried too; a finished trial is remembered on the task.
  const draft = await f.service.createTask(
    caller,
    f.taskInput({ activate: false }),
  );
  const trial = await f.service.runTaskNow(caller, draft.task.id, {
    idempotencyKey: "trial",
  });
  assert.equal(trial.run.status, "queued");
  await f.setRunStatus(trial.run.chatRunId!, "completed");
  await f.tick(new Date());
  const tried = await f.taskRow(draft.task.id);
  assert.equal(tried.status, "draft");
  assert.ok(tried.trialRunAt);
});

test("run now is limited to six an hour per task and refuses without queueing", async () => {
  const { caller } = await ownerAndWorkspace();
  const { task } = await f.service.createTask(
    caller,
    f.taskInput({ activate: false }),
  );
  for (let index = 0; index < 6; index += 1) {
    const { run } = await f.service.runTaskNow(caller, task.id, {
      idempotencyKey: `click-${index}`,
    });
    // Each run ends before the next, so only the limit is in play.
    await f.setRunStatus(run.chatRunId!, "completed");
    await f.tick(new Date());
  }
  try {
    await f.service.runTaskNow(caller, task.id, { idempotencyKey: "click-6" });
    assert.fail("expected a refusal");
  } catch (error) {
    const refused = error as {
      statusCode: number;
      code: string;
      details: { scope: string; limit: number };
    };
    assert.equal(refused.statusCode, 429);
    assert.equal(refused.code, "AGENT_TASK_RUN_RATE_LIMITED");
    assert.equal(refused.details.scope, "task");
    assert.equal(refused.details.limit, 6);
  }
  assert.equal((await f.occurrences(task.id)).length, 6);
  // Repeating an earlier click is still answered, and costs nothing.
  const replay = await f.service.runTaskNow(caller, task.id, {
    idempotencyKey: "click-0",
  });
  assert.equal(replay.created, false);
});

test("run now is limited to twenty an hour per person across their tasks", async () => {
  const { caller } = await ownerAndWorkspace();
  const ids: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    ids.push(
      (await f.service.createTask(caller, f.taskInput({ activate: false })))
        .task.id,
    );
  }
  let accepted = 0;
  let refusedScope: string | null = null;
  for (let index = 0; index < 21; index += 1) {
    try {
      const { run } = await f.service.runTaskNow(caller, ids[index % 4]!, {
        idempotencyKey: `click-${index}`,
      });
      accepted += 1;
      if (run.chatRunId) await f.setRunStatus(run.chatRunId, "completed");
      await f.tick(new Date());
    } catch (error) {
      refusedScope = (error as { details: { scope: string } }).details.scope;
    }
  }
  assert.equal(accepted, 20);
  assert.equal(refusedScope, "user");
});

test("a task that is blocked, completed or deleted cannot be run by hand", async () => {
  const { caller } = await ownerAndWorkspace();
  const { task } = await f.service.createTask(caller, f.taskInput());
  await f.schema.db
    .update(f.schema.agentTasks)
    .set({ status: "blocked", statusReason: "insufficient_credits" })
    .where(eq(f.schema.agentTasks.id, task.id));
  assert.equal(
    await refusal(() =>
      f.service.runTaskNow(caller, task.id, { idempotencyKey: "a" }),
    ),
    "409 AGENT_TASK_INVALID_STATE",
  );
  await f.service.deleteTask(caller, task.id);
  assert.equal(
    await refusal(() =>
      f.service.runTaskNow(caller, task.id, { idempotencyKey: "b" }),
    ),
    "409 AGENT_TASK_ARCHIVED",
  );
  assert.equal(f.started.length, 0);
});

test("deleting archives a task that has run and keeps its history; a draft that never ran is removed", async () => {
  const { caller } = await ownerAndWorkspace();
  const { task } = await f.service.createTask(caller, f.taskInput());
  const { run } = await f.service.runTaskNow(caller, task.id, {
    idempotencyKey: "x",
  });
  await f.service.deleteTask(caller, task.id);

  const archived = await f.service.getTask(caller, task.id);
  assert.equal(archived.task.status, "archived");
  assert.ok(archived.task.archivedAt);
  assert.equal(archived.task.schedule.enabled, false);
  assert.deepEqual((await f.service.listTasks(caller)).tasks, []);
  assert.deepEqual(
    (await f.service.listTaskRuns(caller, task.id, {})).runs.map(
      (item) => item.id,
    ),
    [run.id],
  );
  // The conversation the run produced is still there.
  const [thread] = await f.schema.db
    .select()
    .from(f.schema.threads)
    .where(eq(f.schema.threads.id, run.threadId!));
  assert.equal(thread?.origin, "scheduled");
  assert.equal(
    await refusal(() =>
      f.service.updateTask(caller, task.id, { version: 1, name: "Back" }),
    ),
    "409 AGENT_TASK_ARCHIVED",
  );
  // Its name is free again.
  await f.service.createTask(caller, f.taskInput({ name: task.name }));

  const draft = await f.service.createTask(
    caller,
    f.taskInput({ activate: false }),
  );
  await f.service.deleteTask(caller, draft.task.id);
  assert.equal(
    await refusal(() => f.service.getTask(caller, draft.task.id)),
    "404 AGENT_TASK_NOT_FOUND",
  );
});

test("a name is unique per owner and workspace, whatever its case", async () => {
  const { caller, workspaceId } = await ownerAndWorkspace();
  await f.service.createTask(caller, f.taskInput({ name: "Morning digest" }));
  assert.equal(
    await refusal(() =>
      f.service.createTask(caller, f.taskInput({ name: "morning DIGEST" })),
    ),
    "409 AGENT_TASK_NAME_TAKEN",
  );
  const colleague = randomUUID();
  await f.join(workspaceId, colleague);
  assert.equal(
    await refusal(() =>
      f.service.createTask(
        { workspaceId, userId: colleague },
        f.taskInput({ name: "Morning digest" }),
      ),
    ),
    null,
  );
});

test("the run history pages newest first and says why a slot did not run", async () => {
  const { caller } = await ownerAndWorkspace();
  const { task } = await f.service.createTask(
    caller,
    f.taskInput({ activate: false }),
  );
  const schedule = await f.scheduleRow(task.id);
  const base = Date.UTC(2026, 10, 1);
  await f.schema.db.insert(f.schema.scheduleOccurrences).values(
    [0, 1, 2, 3, 4].map((index) => ({
      id: `${task.id}-${index}`,
      scheduleId: schedule.id,
      teamId: schedule.teamId,
      workspaceId: schedule.workspaceId,
      scheduledFor: new Date(base + index * 60 * 60_000),
      status: "skipped" as const,
      skipReason: "previous_run_active" as const,
    })),
  );
  const first = await f.service.listTaskRuns(caller, task.id, { limit: 2 });
  assert.deepEqual(
    first.runs.map((run) => run.id),
    [`${task.id}-4`, `${task.id}-3`],
  );
  assert.equal(first.runs[0]!.skipReason, "previous_run_active");
  const second = await f.service.listTaskRuns(caller, task.id, {
    limit: 2,
    cursor: first.nextCursor!,
  });
  assert.deepEqual(
    second.runs.map((run) => run.id),
    [`${task.id}-2`, `${task.id}-1`],
  );
  const last = await f.service.listTaskRuns(caller, task.id, {
    limit: 2,
    cursor: second.nextCursor!,
  });
  assert.deepEqual(
    last.runs.map((run) => run.id),
    [`${task.id}-0`],
  );
  assert.equal(last.nextCursor, null);
});
