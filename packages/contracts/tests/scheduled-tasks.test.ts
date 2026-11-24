import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_TASK_LIMITS,
  agentTaskRequestSchema,
  agentTaskRunSchema,
  agentTaskSchema,
  createAgentTaskRequestSchema,
  previewAgentTaskScheduleRequestSchema,
  scheduleOccurrenceStatusSchema,
  scheduleRuleSchema,
  scheduleSkipReasonSchema,
  scheduleTimeZoneSchema,
  scheduleTriggerKindSchema,
  updateAgentTaskRequestSchema,
} from "../src/scheduled-tasks";
import * as contracts from "../src/index";

const accepts = (value: unknown) => scheduleRuleSchema.safeParse(value).success;

test("every rule kind parses and nothing rides along with it", () => {
  for (const rule of [
    { kind: "manual" },
    { kind: "daily", time: "08:00" },
    { kind: "weekly", days: [1, 3, 7], time: "23:59" },
    { kind: "weekdays", time: "00:00" },
    { kind: "cron", expr: "0 8 * * 1-5" },
    { kind: "once", at: "2026-12-01T08:00:00.000Z" },
    { kind: "once", at: "2026-12-01T16:00:00+08:00" },
  ]) {
    assert.deepEqual(scheduleRuleSchema.parse(rule), rule);
    assert.equal(accepts({ ...rule, extra: true }), false);
  }
  // The reserved guard-test shape stays valid.
  assert.equal(accepts({ kind: "once", at: new Date().toISOString() }), true);
});

test("malformed rules are refused", () => {
  for (const rule of [
    {},
    { kind: "interval", minutes: 60 },
    { kind: "daily" },
    { kind: "daily", time: "8:00" },
    { kind: "daily", time: "24:00" },
    { kind: "daily", time: "08:60" },
    { kind: "weekly", days: [], time: "08:00" },
    { kind: "weekly", days: [0], time: "08:00" },
    { kind: "weekly", days: [8], time: "08:00" },
    { kind: "weekly", days: [1, 1], time: "08:00" },
    { kind: "weekly", days: [1.5], time: "08:00" },
    { kind: "weekdays" },
    { kind: "cron", expr: "  " },
    { kind: "cron", expr: "x".repeat(AGENT_TASK_LIMITS.cronChars + 1) },
    { kind: "once", at: "2026-12-01" },
    { kind: "once", at: "2026-12-01T08:00:00" },
    { kind: "once", at: "tomorrow" },
  ])
    assert.equal(accepts(rule), false, JSON.stringify(rule));
});

test("time zones must be IANA names the runtime knows", () => {
  for (const zone of ["UTC", "Asia/Shanghai", "America/New_York"])
    assert.equal(scheduleTimeZoneSchema.safeParse(zone).success, true);
  for (const zone of ["", "Mars/Olympus", "UTC+8", "+08:00"])
    assert.equal(scheduleTimeZoneSchema.safeParse(zone).success, false, zone);
});

test("the request snapshot is a closed list with safe defaults", () => {
  assert.deepEqual(agentTaskRequestSchema.parse({}), {
    sourceIds: [],
    skillIds: [],
    mcp: { installIds: [] },
    webAccess: false,
  });
  const full = {
    sourceIds: ["source_1"],
    llm: { modelAlias: "fast", thinking: { mode: "off" } },
    modelSettings: { llmProfileAlias: "default" },
    skillIds: ["skill_1"],
    mcp: { installIds: ["install_1"] },
    webAccess: true,
  };
  assert.deepEqual(agentTaskRequestSchema.parse(full), full);
  // Unlike the chat request's open tool map, unknown keys are an error, so a
  // write tool cannot be smuggled into a scheduled run.
  for (const smuggled of [
    { tools: { create_notion_page: { enabled: true } } },
    { create_notion_page: { enabled: true } },
    { mcp: { installIds: [], toolIds: ["write"] } },
    { sandbox: true },
  ])
    assert.equal(agentTaskRequestSchema.safeParse(smuggled).success, false);
  assert.equal(
    agentTaskRequestSchema.safeParse({
      sourceIds: Array.from(
        { length: AGENT_TASK_LIMITS.maxSources + 1 },
        (_, index) => `s${index}`,
      ),
    }).success,
    false,
  );
});

const createInput = {
  name: "  Morning digest ",
  prompt: "Summarize what changed in my sources.",
  request: {},
  rule: { kind: "weekdays", time: "08:00" },
  timezone: "Asia/Shanghai",
};

test("create trims the name, defaults to a draft and bounds its text", () => {
  const parsed = createAgentTaskRequestSchema.parse(createInput);
  assert.equal(parsed.name, "Morning digest");
  assert.equal(parsed.activate, false);
  assert.equal(parsed.request.webAccess, false);
  for (const invalid of [
    { ...createInput, name: " " },
    { ...createInput, name: "n".repeat(AGENT_TASK_LIMITS.nameChars + 1) },
    { ...createInput, prompt: "" },
    { ...createInput, prompt: "p".repeat(AGENT_TASK_LIMITS.promptChars + 1) },
    { ...createInput, timezone: "Nowhere/None" },
    { ...createInput, ownerUserId: "someone_else" },
    { ...createInput, userId: "someone_else" },
  ])
    assert.equal(
      createAgentTaskRequestSchema.safeParse(invalid).success,
      false,
    );
});

test("an update needs the version it edits and at least one change", () => {
  assert.equal(
    updateAgentTaskRequestSchema.safeParse({ version: 2, name: "Renamed" })
      .success,
    true,
  );
  assert.equal(
    updateAgentTaskRequestSchema.safeParse({
      version: 2,
      rule: { kind: "manual" },
    }).success,
    true,
  );
  for (const invalid of [
    { name: "Renamed" },
    { version: 2 },
    { version: 0, name: "Renamed" },
    { version: 2, status: "active" },
    { version: 2, ownerUserId: "someone_else" },
  ])
    assert.equal(
      updateAgentTaskRequestSchema.safeParse(invalid).success,
      false,
    );
});

test("a preview request is just the rule and its zone", () => {
  assert.equal(
    previewAgentTaskScheduleRequestSchema.safeParse({
      rule: { kind: "cron", expr: "0 9 * * *" },
      timezone: "Europe/Berlin",
    }).success,
    true,
  );
  assert.equal(
    previewAgentTaskScheduleRequestSchema.safeParse({
      rule: { kind: "cron", expr: "0 9 * * *" },
    }).success,
    false,
  );
});

const task = {
  id: "task_1",
  teamId: "team_1",
  workspaceId: "ws_1",
  ownerUserId: "user_1",
  name: "Morning digest",
  prompt: "Summarize what changed in my sources.",
  request: {
    sourceIds: [],
    skillIds: [],
    mcp: { installIds: [] },
    webAccess: false,
  },
  schedule: {
    rule: { kind: "daily", time: "08:00" },
    timezone: "Asia/Shanghai",
    enabled: true,
    nextDueAt: "2026-12-01T00:02:11.000Z",
  },
  status: "active",
  statusReason: null,
  statusChangedAt: "2026-11-17T00:00:00.000Z",
  consecutiveFailures: 0,
  trialRunAt: null,
  notifyOnSuccess: true,
  notifyEmail: true,
  resultTarget: "new_thread",
  version: 1,
  createdAt: "2026-11-17T00:00:00.000Z",
  updatedAt: "2026-11-17T00:00:00.000Z",
  archivedAt: null,
};

test("a task record round-trips and its status vocabulary is closed", () => {
  assert.deepEqual(agentTaskSchema.parse(task), task);
  assert.equal(
    agentTaskSchema.safeParse({
      ...task,
      status: "blocked",
      statusReason: "insufficient_credits",
    }).success,
    true,
  );
  assert.equal(
    agentTaskSchema.safeParse({ ...task, status: "running" }).success,
    false,
  );
  assert.equal(
    agentTaskSchema.safeParse({ ...task, statusReason: "because" }).success,
    false,
  );
  assert.equal(
    agentTaskSchema.safeParse({ ...task, resultTarget: "existing_thread" })
      .success,
    false,
  );
});

test("a run record carries why it was skipped and what produced it", () => {
  const run = {
    id: "occ_1",
    taskId: "task_1",
    scheduledFor: "2026-12-01T00:00:00.000Z",
    status: "skipped",
    triggerKind: "schedule",
    skipReason: "missed_platform_down",
    detail: null,
    taskVersion: null,
    isCatchUp: false,
    threadId: null,
    chatRunId: null,
    createdAt: "2026-12-01T00:00:00.000Z",
    updatedAt: "2026-12-01T00:00:00.000Z",
  };
  assert.deepEqual(agentTaskRunSchema.parse(run), run);
  // Only the two told apart outcomes are named; anything else is refused.
  assert.equal(
    agentTaskRunSchema.parse({ ...run, detail: "timed_out" }).detail,
    "timed_out",
  );
  assert.equal(
    agentTaskRunSchema.safeParse({ ...run, detail: "run_timeout" }).success,
    false,
  );
  assert.equal(
    agentTaskRunSchema.safeParse({ ...run, skipReason: "overlap" }).success,
    false,
  );
  // The database CHECK constraints are generated from these lists.
  assert.deepEqual(scheduleOccurrenceStatusSchema.options, [
    "pending",
    "dispatching",
    "queued",
    "succeeded",
    "failed",
    "skipped",
    "blocked",
    "cancelled",
  ]);
  assert.deepEqual(scheduleTriggerKindSchema.options, [
    "schedule",
    "manual",
    "api",
    "event",
  ]);
  assert.equal(scheduleSkipReasonSchema.options.length, 9);
});

test("the root entry re-exports the scheduled-task contracts", () => {
  assert.equal(contracts.scheduleRuleSchema, scheduleRuleSchema);
  assert.equal(contracts.agentTaskSchema, agentTaskSchema);
});
