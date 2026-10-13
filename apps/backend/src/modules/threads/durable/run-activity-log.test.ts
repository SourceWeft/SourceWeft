import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { ChatThreadRunRecord } from "./types";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
}));

vi.mock("../../../shared/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: mocks.info,
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { metrics } from "../../../shared/metrics";
import {
  chatRunDurationMs,
  logChatRunFinished,
  logChatRunStarted,
} from "./run-activity-log";

const RUN_ID = "0199cd4f-7b1e-7c3a-9f0e-5d2a1b3c4d5e";
const THREAD_ID = "thread-1234567890";
const TEAM_ID = "team-1234567890";
const WORKSPACE_ID = "workspace-1234567890";

function createRun(input: Partial<ChatThreadRunRecord> = {}): ChatThreadRunRecord {
  return {
    id: RUN_ID,
    teamId: TEAM_ID,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    userId: "user-1",
    userMessageId: null,
    assistantMessageId: null,
    idempotencyKey: "key",
    mode: "send",
    jobId: null,
    streamKey: "stream",
    status: "running",
    eventOffset: 0,
    requestJson: { prompt: "secret prompt text", email: "person@example.com" },
    snapshotJson: {},
    errorCode: null,
    errorMessage: null,
    startedAt: "2026-10-14T10:00:00.000Z",
    heartbeatAt: null,
    finishedAt: null,
    createdAt: "2026-10-14T09:59:50.000Z",
    updatedAt: "2026-10-14T10:00:00.000Z",
    ...input,
  };
}

function fieldsOf(call: unknown[] | undefined) {
  return (call?.[1] ?? {}) as Record<string, unknown>;
}

function assertNoFullIdsOrContent(fields: Record<string, unknown>) {
  const serialized = JSON.stringify(fields);
  for (const full of [RUN_ID, THREAD_ID, TEAM_ID, WORKSPACE_ID]) {
    assert.ok(!serialized.includes(full), `full id leaked: ${full}`);
  }
  assert.ok(!serialized.includes("@"), "email leaked");
  assert.ok(!serialized.includes("secret prompt"), "request content leaked");
}

beforeEach(() => {
  vi.clearAllMocks();
});

test("chat_run.started logs truncated ids only", () => {
  logChatRunStarted(createRun());

  assert.equal(mocks.info.mock.calls[0]?.[0], "chat_run.started");
  const fields = fieldsOf(mocks.info.mock.calls[0]);
  assert.deepEqual(fields, {
    runId: "0199cd4f",
    threadId: "thread-1",
    teamId: "team-123",
    workspaceId: "workspac",
  });
  assertNoFullIdsOrContent(fields);
});

test("chat_run.finished logs status, duration and error code with truncated ids", () => {
  logChatRunFinished(
    createRun({
      status: "failed",
      errorCode: "LLM_CALL_FAILED",
      errorMessage: "Provider said no to person@example.com",
      finishedAt: "2026-10-14T10:00:12.500Z",
    }),
  );

  assert.equal(mocks.info.mock.calls[0]?.[0], "chat_run.finished");
  const fields = fieldsOf(mocks.info.mock.calls[0]);
  assert.deepEqual(fields, {
    runId: "0199cd4f",
    threadId: "thread-1",
    teamId: "team-123",
    workspaceId: "workspac",
    status: "failed",
    durationMs: 12_500,
    errorCode: "LLM_CALL_FAILED",
  });
  assertNoFullIdsOrContent(fields);
  assert.equal("errorMessage" in fields, false);
});

test("chat_run.finished omits errorCode for completed runs and records metrics", () => {
  const before = metrics.snapshot();
  const completedBefore = before.counters["chat_run.finished{status=completed}"] ?? 0;

  logChatRunFinished(
    createRun({
      status: "completed",
      finishedAt: "2026-10-14T10:00:03.000Z",
    }),
  );

  const fields = fieldsOf(mocks.info.mock.calls[0]);
  assert.equal(fields.status, "completed");
  assert.equal(fields.durationMs, 3_000);
  assert.equal("errorCode" in fields, false);

  const after = metrics.snapshot();
  assert.equal(
    after.counters["chat_run.finished{status=completed}"],
    completedBefore + 1,
  );
  const duration = after.observations["chat_run.duration_ms{status=completed}"];
  assert.ok(duration);
  assert.ok(duration.max >= 3_000);
});

test("duration falls back to createdAt and is null when the finish time is unknown", () => {
  assert.equal(
    chatRunDurationMs({
      startedAt: null,
      createdAt: "2026-10-14T09:59:50.000Z",
      finishedAt: "2026-10-14T10:00:00.000Z",
    }),
    10_000,
  );
  assert.equal(
    chatRunDurationMs({
      startedAt: "2026-10-14T10:00:00.000Z",
      createdAt: "2026-10-14T10:00:00.000Z",
      finishedAt: null,
    }),
    null,
  );
  assert.equal(
    chatRunDurationMs({
      startedAt: "2026-10-14T10:00:05.000Z",
      createdAt: "2026-10-14T10:00:05.000Z",
      finishedAt: "2026-10-14T10:00:00.000Z",
    }),
    0,
  );
});
