import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import {
  createAgentTaskFixture,
  type AgentTaskFixture,
} from "../../test/agent-task-fixture";

let f: AgentTaskFixture;

const HOUR = 60 * 60_000;
// The top of the current hour is every hourly task's newest slot; half past
// is "now", late enough for that slot to count as a catch-up when it is only
// materialized then.
const SLOT = new Date(Math.floor(Date.now() / HOUR) * HOUR);
const NOW = new Date(SLOT.getTime() + 30 * 60_000);
const at = (hours: number) => new Date(SLOT.getTime() + hours * HOUR);

beforeAll(async () => {
  f = await createAgentTaskFixture("agent_task_run");
}, 120_000);

beforeEach(async () => {
  f.reset();
  // Every test starts with no task left over that could become due.
  await f.schema.db.delete(f.schema.agentTasks);
});

afterAll(async () => {
  await f?.close();
});

/** An active hourly task of a fresh owner, due for the slot at `dueAt`. */
async function dueTask(
  options: {
    dueAt?: Date;
    input?: Parameters<AgentTaskFixture["taskInput"]>[0];
  } = {},
) {
  const owner = randomUUID();
  const tenant = await f.workspace(owner);
  const caller = { workspaceId: tenant.workspaceId, userId: owner };
  const { task } = await f.service.createTask(
    caller,
    f.taskInput(options.input),
  );
  await f.setDue(task.id, options.dueAt ?? SLOT);
  f.audits.length = 0;
  return { owner, caller, ...tenant, taskId: task.id, name: task.name };
}

const kinds = () => f.notifications.map((item) => item.kind);

async function chatRuns(workspaceId: string) {
  return f.schema.db
    .select()
    .from(f.schema.chatThreadRuns)
    .where(eq(f.schema.chatThreadRuns.workspaceId, workspaceId));
}

test("a due slot starts one ordinary chat run in a new scheduled conversation of the owner", async () => {
  const { owner, workspaceId, teamId, taskId, name } = await dueTask();
  await f.tick(new Date(SLOT.getTime() + 6 * 60_000));

  const [occurrence, ...rest] = await f.occurrences(taskId);
  assert.deepEqual(rest, []);
  assert.equal(occurrence!.status, "queued");
  assert.equal(occurrence!.triggerKind, "schedule");
  assert.equal(occurrence!.scheduledFor.getTime(), SLOT.getTime());
  assert.equal(occurrence!.isCatchUp, false);
  assert.equal(occurrence!.taskVersion, 1);
  assert.equal(occurrence!.teamId, teamId);
  assert.equal(occurrence!.workspaceId, workspaceId);

  const [turn] = f.started;
  assert.equal(turn!.userId, owner);
  assert.equal(turn!.workspaceId, workspaceId);
  assert.equal(turn!.content, "Summarize what is new in my sources");
  assert.equal(turn!.title, `${name} · ${SLOT.toISOString().slice(0, 10)}`);
  assert.equal(turn!.threadId, occurrence!.threadId);
  assert.deepEqual(turn!.tools, {
    skillIds: [],
    web_search: { enabled: false },
    web_fetch: { enabled: false },
  });
  const [thread] = await f.schema.db
    .select()
    .from(f.schema.threads)
    .where(eq(f.schema.threads.id, occurrence!.threadId!));
  assert.equal(thread!.origin, "scheduled");
  assert.equal(thread!.createdBy, owner);
  // On time: nothing to tell the owner until the run ends.
  assert.deepEqual(kinds(), []);
  // The schedule moved on to the next hour.
  const schedule = await f.scheduleRow(taskId);
  assert.equal(
    schedule.nextDueAt!.getTime(),
    at(1).getTime() + f.tasks.agentTaskOffsetMs(taskId),
  );
});

test("two schedulers racing on one slot produce exactly one run", async () => {
  const { workspaceId, taskId } = await dueTask();
  const now = new Date(SLOT.getTime() + 6 * 60_000);
  await Promise.all([f.tick(now), f.tick(now), f.tick(now)]);

  const occurrences = await f.occurrences(taskId);
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0]!.status, "queued");
  assert.equal(occurrences[0]!.attempts, 1);
  assert.equal(f.started.length, 1);
  assert.equal((await chatRuns(workspaceId)).length, 1);
});

test("a dispatch replayed after a crash finds the conversation and run it already made", async () => {
  const { workspaceId, taskId } = await dueTask();
  const now = new Date(SLOT.getTime() + 6 * 60_000);
  await f.tasks.materializeAgentTaskSlots({ now }, f.ports);
  const [claimed] = await f.tasks.claimAgentTaskOccurrences({ now });
  // The first dispatcher started the run and died before recording it.
  await f.ports.startTurn({
    workspaceId,
    userId: (await f.taskRow(taskId)).ownerUserId,
    ...f.tasks.scheduledRunIdentity(taskId, claimed!.occurrence.id),
    title: "t",
    content: "c",
  });
  // Its lease runs out and another scheduler takes the slot.
  const later = new Date(now.getTime() + 6 * 60_000);
  const [reclaimed] = await f.tasks.claimAgentTaskOccurrences({ now: later });
  assert.equal(reclaimed!.occurrence.id, claimed!.occurrence.id);
  await f.tasks.dispatchAgentTaskOccurrence(reclaimed!, f.ports, later);

  const [occurrence] = await f.occurrences(taskId);
  const runs = await chatRuns(workspaceId);
  assert.equal(runs.length, 1);
  assert.equal(occurrence!.status, "queued");
  assert.equal(occurrence!.chatRunId, runs[0]!.id);
  assert.equal(
    (
      await f.schema.db
        .select()
        .from(f.schema.threads)
        .where(eq(f.schema.threads.workspaceId, workspaceId))
    ).length,
    1,
  );
});

test("after the platform was down only the newest slot runs, once, marked as a catch-up; older ones are recorded as missed", async () => {
  const { taskId } = await dueTask({ dueAt: at(-3) });
  await f.tick(NOW);
  await f.tick(NOW);
  await f.tick(new Date(NOW.getTime() + 60_000));

  const occurrences = await f.occurrences(taskId);
  assert.deepEqual(
    occurrences.map((row) => [
      (row.scheduledFor.getTime() - SLOT.getTime()) / HOUR,
      row.status,
      row.skipReason,
      row.isCatchUp,
    ]),
    [
      [-3, "skipped", "missed_platform_down", false],
      [-2, "skipped", "missed_platform_down", false],
      [-1, "skipped", "missed_platform_down", false],
      [0, "queued", null, true],
    ],
  );
  assert.equal(f.started.length, 1);
  // The owner is told in the app, not by mail.
  assert.deepEqual(
    f.notifications.map((item) => [
      item.kind,
      item.email,
      item.payload?.scheduledFor,
    ]),
    [["task_run_catch_up", false, SLOT.toISOString()]],
  );
});

test("a slot older than its period is not run at all", async () => {
  // A weekly rule whose only slot this week was more than a day ago.
  const weekday = ((at(-30).getUTCDay() + 6) % 7) + 1;
  const time = at(-30).toISOString().slice(11, 16);
  const { taskId } = await dueTask({
    dueAt: at(-30),
    input: { rule: { kind: "weekly", days: [weekday], time } },
  });
  await f.tick(NOW);
  const occurrences = await f.occurrences(taskId);
  assert.deepEqual(
    occurrences.map((row) => [row.status, row.skipReason]),
    [["skipped", "missed_platform_down"]],
  );
  assert.equal(f.started.length, 0);
  assert.equal((await f.taskRow(taskId)).status, "active");
});

test("a slot is skipped while the task's previous run is still going", async () => {
  const { taskId } = await dueTask();
  await f.tick(new Date(SLOT.getTime() + 6 * 60_000));
  await f.tick(new Date(at(1).getTime() + 6 * 60_000));

  const occurrences = await f.occurrences(taskId);
  assert.deepEqual(
    occurrences.map((row) => [row.status, row.skipReason]),
    [
      ["queued", null],
      ["skipped", "previous_run_active"],
    ],
  );
  assert.equal(f.started.length, 1);
  // Not a miss: the skipped slot is not made up for once the run ends.
  await f.setRunStatus(occurrences[0]!.chatRunId!, "completed");
  await f.tick(new Date(at(1).getTime() + 10 * 60_000));
  assert.equal((await f.occurrences(taskId)).length, 2);
  assert.equal(f.started.length, 1);
});

test("one person has at most two scheduled runs going at once", async () => {
  const owner = randomUUID();
  const tenant = await f.workspace(owner);
  const caller = { workspaceId: tenant.workspaceId, userId: owner };
  const ids: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const { task } = await f.service.createTask(caller, f.taskInput());
    await f.setDue(task.id, SLOT);
    ids.push(task.id);
  }
  await f.tick(new Date(SLOT.getTime() + 6 * 60_000));

  const outcomes = (await Promise.all(ids.map((id) => f.occurrences(id)))).map(
    ([row]) => `${row!.status}:${row!.skipReason}`,
  );
  assert.deepEqual(outcomes.sort(), [
    "queued:null",
    "queued:null",
    "skipped:user_concurrency_limit",
  ]);
  assert.equal(f.started.length, 2);
});

test("the fifty-first run of a person within a day is skipped, scheduled or by hand", async () => {
  const { caller, taskId } = await dueTask();
  const schedule = await f.scheduleRow(taskId);
  // Fifty runs already started in the last day.
  await f.schema.db.execute(sql`
    insert into schedule_occurrences
      (id, schedule_id, team_id, workspace_id, scheduled_for, status, task_version, created_at)
    select 'past-' || n, ${schedule.id}, ${schedule.teamId}, ${schedule.workspaceId},
           ${at(-20).toISOString()}::timestamptz - (n || ' seconds')::interval,
           'succeeded', 1, ${at(-2).toISOString()}::timestamptz
    from generate_series(1, ${f.tasks.AGENT_TASK_DAILY_RUN_CAP}) as n
  `);
  await f.tick(new Date(SLOT.getTime() + 6 * 60_000));
  const scheduled = (await f.occurrences(taskId)).at(-1)!;
  assert.deepEqual(
    [scheduled.status, scheduled.skipReason],
    ["skipped", "user_daily_cap"],
  );

  const manual = await f.service.runTaskNow(caller, taskId, {
    idempotencyKey: "k",
  });
  assert.deepEqual(
    [manual.run.status, manual.run.skipReason],
    ["skipped", "user_daily_cap"],
  );
  assert.equal(f.started.length, 0);
  assert.equal((await f.taskRow(taskId)).status, "active");
});

test("without credits the slot and the task are blocked and the owner is told; credits bring the task back without a catch-up", async () => {
  const { owner, teamId, taskId, name } = await dueTask();
  f.state.credits = false;
  const blockedAt = new Date(SLOT.getTime() + 6 * 60_000);
  await f.tick(blockedAt);

  const [occurrence] = await f.occurrences(taskId);
  assert.deepEqual(
    [occurrence!.status, occurrence!.skipReason],
    ["blocked", "insufficient_credits"],
  );
  let task = await f.taskRow(taskId);
  assert.deepEqual(
    [task.status, task.statusReason],
    ["blocked", "insufficient_credits"],
  );
  let schedule = await f.scheduleRow(taskId);
  assert.deepEqual([schedule.enabled, schedule.nextDueAt], [false, null]);
  assert.equal(f.started.length, 0);
  assert.deepEqual(f.notifications, [
    {
      kind: "task_blocked_quota",
      teamId,
      userId: owner,
      ref: { kind: "agent_task", id: taskId },
      payload: { taskName: name },
    },
  ]);
  assert.deepEqual(
    f.audits.map((entry) => [entry.action, entry.actorUserId, entry.metadata]),
    [["agent_task.blocked", null, { reason: "insufficient_credits" }]],
  );

  // Hours go by without credits: the task stays blocked and silent.
  await f.schema.db
    .update(f.schema.agentTasks)
    .set({ updatedAt: blockedAt })
    .where(eq(f.schema.agentTasks.id, taskId));
  await f.tick(at(3));
  assert.equal((await f.taskRow(taskId)).status, "blocked");
  assert.equal(f.notifications.length, 1);
  assert.equal((await f.occurrences(taskId)).length, 1);

  // Topped up. The block is looked at every ten minutes, not every tick.
  f.state.credits = true;
  await f.tick(new Date(at(3).getTime() + 5 * 60_000));
  assert.equal((await f.taskRow(taskId)).status, "blocked");
  const resumedAt = new Date(at(3).getTime() + 30 * 60_000);
  await f.tick(resumedAt);
  task = await f.taskRow(taskId);
  assert.deepEqual([task.status, task.statusReason], ["active", null]);
  schedule = await f.scheduleRow(taskId);
  assert.equal(schedule.enabled, true);
  // Due at the next slot after the top-up; the three it sat out are gone.
  assert.equal(
    schedule.nextDueAt!.getTime(),
    at(4).getTime() + f.tasks.agentTaskOffsetMs(taskId),
  );
  await f.tick(new Date(resumedAt.getTime() + 60_000));
  assert.equal((await f.occurrences(taskId)).length, 1);
  assert.equal(f.started.length, 0);
  assert.equal(f.audits.at(-1)!.action, "agent_task.resumed");

  // The next slot runs as usual, and not as a catch-up.
  await f.tick(new Date(at(4).getTime() + 6 * 60_000));
  const latest = (await f.occurrences(taskId)).at(-1)!;
  assert.deepEqual([latest.status, latest.isCatchUp], ["queued", false]);
});

test("a run on the owner's own model key does not need credits", async () => {
  const { taskId } = await dueTask({
    input: {
      request: {
        sourceIds: [],
        skillIds: [],
        mcp: { installIds: [] },
        webAccess: true,
        llm: { executionMode: "BYOK", byokModelId: "byok-1" },
      },
    },
  });
  f.state.credits = false;
  await f.tick(new Date(SLOT.getTime() + 6 * 60_000));
  assert.equal((await f.occurrences(taskId))[0]!.status, "queued");
  assert.deepEqual(f.started[0]!.tools, {
    skillIds: [],
    web_search: { enabled: true },
    web_fetch: { enabled: true },
  });
});

test("when the owner leaves the workspace the task pauses; nobody else runs or pays for it", async () => {
  const { owner, workspaceId, taskId } = await dueTask();
  const colleague = randomUUID();
  await f.join(workspaceId, colleague);
  await f.leave(workspaceId, owner);
  await f.tick(new Date(SLOT.getTime() + 6 * 60_000));

  const [occurrence] = await f.occurrences(taskId);
  assert.deepEqual(
    [occurrence!.status, occurrence!.skipReason],
    ["blocked", "owner_left"],
  );
  const task = await f.taskRow(taskId);
  assert.deepEqual(
    [task.status, task.statusReason, task.ownerUserId],
    ["paused", "owner_left", owner],
  );
  assert.equal((await f.scheduleRow(taskId)).enabled, false);
  assert.equal(f.started.length, 0);
  assert.deepEqual(
    f.notifications.map((item) => [item.kind, item.userId]),
    [["task_paused_owner_left", owner]],
  );
  // It does not come back by itself, and it is not handed to the colleague.
  await f.tick(at(5));
  assert.equal((await f.taskRow(taskId)).status, "paused");
  assert.deepEqual(
    (await f.service.listTasks({ workspaceId, userId: colleague })).tasks,
    [],
  );
});

test("three failed runs in a row pause the task; a success in between starts the count again", async () => {
  const { taskId } = await dueTask();
  const runSlot = async (hour: number, outcome: "completed" | "failed") => {
    await f.tick(new Date(at(hour).getTime() + 6 * 60_000));
    const occurrence = (await f.occurrences(taskId)).at(-1)!;
    assert.equal(occurrence.status, "queued");
    await f.setRunStatus(occurrence.chatRunId!, outcome, {
      errorCode: outcome === "failed" ? "MODEL_ERROR" : null,
    });
    await f.tick(new Date(at(hour).getTime() + 20 * 60_000));
  };

  await runSlot(0, "failed");
  await runSlot(1, "failed");
  assert.equal((await f.taskRow(taskId)).consecutiveFailures, 2);
  await runSlot(2, "completed");
  assert.equal((await f.taskRow(taskId)).consecutiveFailures, 0);
  await runSlot(3, "failed");
  await runSlot(4, "failed");
  assert.equal((await f.taskRow(taskId)).status, "active");
  await runSlot(5, "failed");

  const task = await f.taskRow(taskId);
  assert.deepEqual(
    [task.status, task.statusReason, task.consecutiveFailures],
    ["paused", "repeated_failure", 3],
  );
  assert.equal((await f.scheduleRow(taskId)).enabled, false);
  assert.deepEqual(kinds(), [
    "task_run_failed",
    "task_run_failed",
    "task_run_succeeded",
    "task_run_failed",
    "task_run_failed",
    "task_run_failed",
    "task_paused_repeated_failure",
  ]);
  assert.deepEqual(
    (await f.occurrences(taskId)).map((row) => [row.status, row.lastError]),
    [
      ["failed", "MODEL_ERROR"],
      ["failed", "MODEL_ERROR"],
      ["succeeded", null],
      ["failed", "MODEL_ERROR"],
      ["failed", "MODEL_ERROR"],
      ["failed", "MODEL_ERROR"],
    ],
  );
  // Paused for good: later slots do not appear.
  await f.tick(at(8));
  assert.equal((await f.occurrences(taskId)).length, 6);
});

test("missing tools block the task, and after 72 hours without them it pauses", async () => {
  const gone = await dueTask();
  f.state.toolsAvailable = false;
  const blockedAt = new Date(SLOT.getTime() + 6 * 60_000);
  await f.tick(blockedAt);

  const [occurrence] = await f.occurrences(gone.taskId);
  assert.deepEqual(
    [occurrence!.status, occurrence!.skipReason],
    ["blocked", "tools_unavailable"],
  );
  const task = await f.taskRow(gone.taskId);
  assert.deepEqual(
    [task.status, task.statusReason],
    ["blocked", "tools_unavailable"],
  );
  assert.deepEqual(
    f.notifications.map((item) => [item.kind, item.payload?.state, item.email]),
    [["task_tools_unavailable", "blocked", false]],
  );
  assert.equal(f.started.length, 0);
  f.notifications.length = 0;

  // Still gone a day before the deadline: blocked, and nothing new is said.
  await f.tick(new Date(blockedAt.getTime() + 71 * HOUR));
  assert.equal((await f.taskRow(gone.taskId)).status, "blocked");
  assert.deepEqual(kinds(), []);

  await f.tick(new Date(blockedAt.getTime() + 73 * HOUR));
  const paused = await f.taskRow(gone.taskId);
  assert.deepEqual(
    [paused.status, paused.statusReason],
    ["paused", "tools_unavailable"],
  );
  assert.deepEqual(
    f.notifications.map((item) => [item.kind, item.payload?.state]),
    [["task_tools_unavailable", "paused"]],
  );
});

test("a task blocked on missing tools goes back to work when they return", async () => {
  const { taskId } = await dueTask();
  f.state.toolsAvailable = false;
  const blockedAt = new Date(SLOT.getTime() + 6 * 60_000);
  await f.tick(blockedAt);
  assert.equal((await f.taskRow(taskId)).status, "blocked");
  await f.schema.db
    .update(f.schema.agentTasks)
    .set({ updatedAt: blockedAt })
    .where(eq(f.schema.agentTasks.id, taskId));

  f.state.toolsAvailable = true;
  await f.tick(new Date(blockedAt.getTime() + 2 * HOUR));
  const task = await f.taskRow(taskId);
  assert.deepEqual([task.status, task.statusReason], ["active", null]);
  assert.equal((await f.occurrences(taskId)).length, 1);
});

test("a finished run tells the owner once; mail is only for what went wrong, and nothing carries the result", async () => {
  const { owner, teamId, taskId, name } = await dueTask();
  await f.tick(new Date(SLOT.getTime() + 6 * 60_000));
  const [occurrence] = await f.occurrences(taskId);
  await f.setRunStatus(occurrence!.chatRunId!, "completed");
  const later = new Date(SLOT.getTime() + 20 * 60_000);
  await Promise.all([f.tick(later), f.tick(later)]);
  await f.tick(new Date(later.getTime() + 60_000));

  assert.equal((await f.occurrences(taskId))[0]!.status, "succeeded");
  assert.deepEqual(f.notifications, [
    {
      kind: "task_run_succeeded",
      teamId,
      userId: owner,
      ref: { kind: "agent_task", id: taskId },
      payload: { taskName: name, threadId: occurrence!.threadId },
    },
  ]);
  assert.ok((await f.scheduleRow(taskId)).lastSuccessAt);
});

test("the task's switches turn the success notice and all mail off", async () => {
  const { caller, taskId } = await dueTask({
    input: { notifyOnSuccess: false, notifyEmail: false },
  });
  await f.tick(new Date(SLOT.getTime() + 6 * 60_000));
  await f.setRunStatus(
    (await f.occurrences(taskId))[0]!.chatRunId!,
    "completed",
  );
  await f.tick(new Date(SLOT.getTime() + 20 * 60_000));
  assert.deepEqual(kinds(), []);

  const failed = await f.service.runTaskNow(caller, taskId, {
    idempotencyKey: "f",
  });
  await f.setRunStatus(failed.run.chatRunId!, "failed", {
    errorCode: "MODEL_ERROR",
  });
  await f.tick(new Date(SLOT.getTime() + 25 * 60_000));
  assert.deepEqual(
    f.notifications.map((item) => [item.kind, item.email]),
    [["task_run_failed", false]],
  );
  // A trial that fails is reported but does not count toward the pause.
  assert.equal((await f.taskRow(taskId)).consecutiveFailures, 0);
});

test("a run its owner stopped is cancelled: no failure, no notice", async () => {
  const { taskId } = await dueTask();
  await f.tick(new Date(SLOT.getTime() + 6 * 60_000));
  const [occurrence] = await f.occurrences(taskId);
  await f.setRunStatus(occurrence!.chatRunId!, "cancelled", {
    errorCode: "CLIENT_CANCELLED",
  });
  await f.tick(new Date(SLOT.getTime() + 20 * 60_000));

  assert.equal((await f.occurrences(taskId))[0]!.status, "cancelled");
  assert.equal((await f.taskRow(taskId)).consecutiveFailures, 0);
  assert.deepEqual(kinds(), []);
});

test("a run still going after thirty minutes is stopped and recorded as failed", async () => {
  const { taskId } = await dueTask();
  await f.tick(new Date(SLOT.getTime() + 6 * 60_000));
  const [occurrence] = await f.occurrences(taskId);
  await f.schema.db
    .update(f.schema.chatThreadRuns)
    .set({
      status: "running",
      createdAt: new Date(SLOT.getTime() + 6 * 60_000),
    })
    .where(eq(f.schema.chatThreadRuns.id, occurrence!.chatRunId!));

  await f.tick(new Date(SLOT.getTime() + 30 * 60_000));
  assert.equal(f.stopped.length, 0);
  await f.tick(new Date(SLOT.getTime() + 40 * 60_000));
  assert.equal(f.stopped.length, 1);
  assert.equal(f.stopped[0]!.threadId, occurrence!.threadId);
  await f.tick(new Date(SLOT.getTime() + 41 * 60_000));

  const [after] = await f.occurrences(taskId);
  assert.deepEqual(
    [after!.status, after!.lastError],
    ["failed", "run_timeout"],
  );
  assert.deepEqual(kinds(), ["task_run_failed"]);
  assert.equal((await f.taskRow(taskId)).consecutiveFailures, 1);
});

test("an approval nobody can give is announced once and fails the run when it expires", async () => {
  const { taskId } = await dueTask();
  await f.tick(new Date(SLOT.getTime() + 6 * 60_000));
  const [occurrence] = await f.occurrences(taskId);
  await f.setRunStatus(occurrence!.chatRunId!, "waiting_for_approval");
  await f.tick(new Date(SLOT.getTime() + 10 * 60_000));
  await f.tick(new Date(SLOT.getTime() + 50 * 60_000));
  assert.deepEqual(kinds(), ["task_needs_approval"]);
  // Waiting is not running: it is not stopped for taking long.
  assert.equal(f.stopped.length, 0);
  assert.equal((await f.occurrences(taskId))[0]!.status, "queued");

  await f.setRunStatus(occurrence!.chatRunId!, "cancelled", {
    errorCode: "TOOL_APPROVAL_EXPIRED",
  });
  await f.tick(new Date(SLOT.getTime() + 55 * 60_000));
  const [after] = await f.occurrences(taskId);
  assert.deepEqual(
    [after!.status, after!.lastError],
    ["failed", "approval_expired"],
  );
  assert.deepEqual(kinds(), ["task_needs_approval", "task_run_failed"]);
});

test("a run whose chat run is gone fails instead of waiting forever", async () => {
  const { taskId } = await dueTask();
  await f.tick(new Date(SLOT.getTime() + 6 * 60_000));
  const [occurrence] = await f.occurrences(taskId);
  await f.schema.db
    .delete(f.schema.chatThreadRuns)
    .where(eq(f.schema.chatThreadRuns.id, occurrence!.chatRunId!));
  await f.tick(new Date(SLOT.getTime() + 8 * 60_000));
  const [after] = await f.occurrences(taskId);
  assert.deepEqual(
    [after!.status, after!.lastError],
    ["failed", "run_missing"],
  );
});

test("only starting a run is retried: three attempts, then the slot fails", async () => {
  const { taskId } = await dueTask();
  f.state.startErrors = [
    new Error("queue down"),
    new Error("queue down"),
    new Error("queue down"),
  ];
  let now = new Date(SLOT.getTime() + 6 * 60_000);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await f.tick(now);
    const [occurrence] = await f.occurrences(taskId);
    assert.equal(occurrence!.attempts, attempt);
    assert.equal(occurrence!.status, attempt < 3 ? "pending" : "failed");
    // Wait out the backoff.
    now = new Date(now.getTime() + 10 * 60_000);
    await f.schema.db
      .update(f.schema.scheduleOccurrences)
      .set({ retryAt: new Date(now.getTime() - 1000) })
      .where(eq(f.schema.scheduleOccurrences.status, "pending"));
  }
  assert.equal(f.started.length, 3);
  assert.deepEqual(kinds(), ["task_run_failed"]);
  assert.equal((await f.taskRow(taskId)).consecutiveFailures, 1);
  assert.equal((await f.occurrences(taskId))[0]!.lastError, "queue down");
});

test("a start that can never work fails at once", async () => {
  const { taskId } = await dueTask();
  f.state.startErrors = [
    Object.assign(new Error("Model not available"), { statusCode: 400 }),
  ];
  await f.tick(new Date(SLOT.getTime() + 6 * 60_000));
  const [occurrence] = await f.occurrences(taskId);
  assert.deepEqual([occurrence!.status, occurrence!.attempts], ["failed", 1]);
  assert.deepEqual(kinds(), ["task_run_failed"]);
});

test("trouble before the run exists is retried too, and one task's trouble does not stop the others", async () => {
  const broken = await dueTask();
  const fine = await dueTask();
  let billingCalls = 0;
  const ports = {
    ...f.ports,
    hasCredits: async (input: { userId: string }) => {
      if (input.userId !== broken.owner) return true;
      billingCalls += 1;
      throw new Error("billing unreachable");
    },
  };
  const now = new Date(SLOT.getTime() + 6 * 60_000);
  await f.tasks.materializeAgentTaskSlots({ now }, ports);
  for (const item of await f.tasks.claimAgentTaskOccurrences({ now })) {
    await f.tasks.dispatchAgentTaskOccurrence(item, ports, now);
  }
  assert.equal(billingCalls, 1);
  const [stuck] = await f.occurrences(broken.taskId);
  assert.deepEqual(
    [stuck!.status, stuck!.lastError, stuck!.attempts],
    ["pending", "billing unreachable", 1],
  );
  assert.ok(stuck!.retryAt);
  assert.equal((await f.occurrences(fine.taskId))[0]!.status, "queued");
  // Nothing was decided about the task itself.
  assert.equal((await f.taskRow(broken.taskId)).status, "active");
});

test("a schedule that cannot be read is skipped without stopping the others", async () => {
  const broken = await dueTask();
  const fine = await dueTask();
  await f.schema.db
    .update(f.schema.taskSchedules)
    .set({ specVersion: 99 })
    .where(eq(f.schema.taskSchedules.agentTaskId, broken.taskId));
  await f.tick(new Date(SLOT.getTime() + 6 * 60_000));
  assert.deepEqual(await f.occurrences(broken.taskId), []);
  assert.equal((await f.occurrences(fine.taskId))[0]!.status, "queued");
});

test("a start that fails once runs on the retry, in the same conversation", async () => {
  const { taskId } = await dueTask();
  f.state.startErrors = [new Error("queue down")];
  const now = new Date(SLOT.getTime() + 6 * 60_000);
  await f.tick(now);
  await f.schema.db
    .update(f.schema.scheduleOccurrences)
    .set({ retryAt: now })
    .where(eq(f.schema.scheduleOccurrences.status, "pending"));
  await f.tick(new Date(now.getTime() + 60_000));
  const [occurrence] = await f.occurrences(taskId);
  assert.deepEqual([occurrence!.status, occurrence!.attempts], ["queued", 2]);
  assert.equal(f.started[0]!.threadId, f.started[1]!.threadId);
  assert.equal(f.started[0]!.idempotencyKey, f.started[1]!.idempotencyKey);
});

test("pausing cancels a slot that was waiting to retry, so it does not run after resume", async () => {
  const { caller, taskId } = await dueTask();
  f.state.startErrors = [new Error("queue down")];
  const now = new Date(SLOT.getTime() + 6 * 60_000);
  await f.tick(now);
  await f.service.pauseTask(caller, taskId);
  assert.equal((await f.occurrences(taskId))[0]!.status, "cancelled");
  await f.service.resumeTask(caller, taskId);
  await f.tick(new Date(now.getTime() + 20 * 60_000));
  assert.equal(f.started.length, 1);
  assert.equal((await f.occurrences(taskId)).length, 1);
});

test("a one-time task runs at its moment and is then completed", async () => {
  const owner = randomUUID();
  const tenant = await f.workspace(owner);
  const caller = { workspaceId: tenant.workspaceId, userId: owner };
  const moment = new Date(Date.now() + 2 * HOUR);
  const { task } = await f.service.createTask(
    caller,
    f.taskInput({ rule: { kind: "once", at: moment.toISOString() } }),
  );
  assert.equal(task.schedule.enabled, true);

  await f.tick(new Date(moment.getTime() - 60_000));
  assert.deepEqual(await f.occurrences(task.id), []);
  const due = new Date(moment.getTime() + 6 * 60_000);
  await f.tick(due);
  const [occurrence] = await f.occurrences(task.id);
  assert.equal(occurrence!.status, "queued");
  assert.equal(occurrence!.scheduledFor.getTime(), moment.getTime());
  assert.equal((await f.scheduleRow(task.id)).nextDueAt, null);

  await f.setRunStatus(occurrence!.chatRunId!, "completed");
  await f.tick(new Date(due.getTime() + 60_000));
  const row = await f.taskRow(task.id);
  assert.equal(row.status, "completed");
  assert.equal((await f.scheduleRow(task.id)).enabled, false);
  await f.tick(new Date(due.getTime() + 5 * HOUR));
  assert.equal((await f.occurrences(task.id)).length, 1);
});

test("a one-time task missed by more than a day is not run late; it is closed and the owner is told", async () => {
  const owner = randomUUID();
  const tenant = await f.workspace(owner);
  const caller = { workspaceId: tenant.workspaceId, userId: owner };
  const moment = new Date(Date.now() + HOUR);
  const { task } = await f.service.createTask(
    caller,
    f.taskInput({ rule: { kind: "once", at: moment.toISOString() } }),
  );
  await f.tick(new Date(moment.getTime() + 30 * HOUR));
  assert.deepEqual(
    (await f.occurrences(task.id)).map((row) => [row.status, row.skipReason]),
    [["skipped", "missed_platform_down"]],
  );
  assert.equal(f.started.length, 0);
  assert.equal((await f.taskRow(task.id)).status, "completed");
  assert.deepEqual(
    f.notifications.map((item) => [item.kind, item.payload?.reason]),
    [["task_run_failed", "missed_platform_down"]],
  );
});

test("a manual task never becomes due and a paused task's slots are never claimed", async () => {
  const owner = randomUUID();
  const tenant = await f.workspace(owner);
  const caller = { workspaceId: tenant.workspaceId, userId: owner };
  const { task } = await f.service.createTask(
    caller,
    f.taskInput({ rule: { kind: "manual" } }),
  );
  assert.equal(task.status, "active");
  assert.deepEqual(
    [task.schedule.enabled, task.schedule.nextDueAt],
    [false, null],
  );
  await f.tick(at(48));
  assert.deepEqual(await f.occurrences(task.id), []);
  // It still runs when asked.
  const { run } = await f.service.runTaskNow(caller, task.id, {
    idempotencyKey: "go",
  });
  assert.equal(run.status, "queued");
});

test("a manual run whose request died mid-way is picked up by the scheduler once its lease ends", async () => {
  const owner = randomUUID();
  const tenant = await f.workspace(owner);
  const caller = { workspaceId: tenant.workspaceId, userId: owner };
  const { task } = await f.service.createTask(
    caller,
    f.taskInput({ activate: false }),
  );
  const schedule = await f.scheduleRow(task.id);
  const now = new Date();
  // What run-now leaves behind when the process dies before dispatching.
  await f.schema.db.insert(f.schema.scheduleOccurrences).values({
    id: randomUUID(),
    scheduleId: schedule.id,
    teamId: schedule.teamId,
    workspaceId: schedule.workspaceId,
    scheduledFor: now,
    status: "dispatching",
    triggerKind: "manual",
    attempts: 1,
    leaseUntil: new Date(now.getTime() + 5 * 60_000),
  });
  await f.tick(new Date(now.getTime() + 60_000));
  assert.equal(f.started.length, 0);
  await f.tick(new Date(now.getTime() + 6 * 60_000));
  const [occurrence] = await f.occurrences(task.id);
  assert.deepEqual(
    [occurrence!.status, occurrence!.triggerKind, occurrence!.attempts],
    ["queued", "manual", 2],
  );
  assert.equal(f.started.length, 1);
});

test("a notification failure never changes what happens to the run", async () => {
  const { taskId } = await dueTask();
  const failing = {
    ...f.ports,
    notify: async () => {
      throw new Error("mail down");
    },
  };
  const now = new Date(SLOT.getTime() + 6 * 60_000);
  await f.tasks.materializeAgentTaskSlots({ now }, failing);
  for (const item of await f.tasks.claimAgentTaskOccurrences({ now })) {
    await f.tasks.dispatchAgentTaskOccurrence(item, failing, now);
  }
  const [occurrence] = await f.occurrences(taskId);
  await f.setRunStatus(occurrence!.chatRunId!, "failed", {
    errorCode: "MODEL_ERROR",
  });
  for (const item of await f.tasks.listAgentTaskRunsToReconcile(10, now)) {
    await f.tasks.reconcileAgentTaskRun(item, failing, now);
  }
  assert.equal((await f.occurrences(taskId))[0]!.status, "failed");
  assert.equal((await f.taskRow(taskId)).consecutiveFailures, 1);
});
