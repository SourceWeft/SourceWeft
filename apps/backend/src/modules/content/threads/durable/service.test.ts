import assert from "node:assert/strict";
import test from "node:test";
import type { ChatThreadRunRecord } from "./types";
import {
  isStaleActiveRun,
  normalizeRetrievalSnapshot,
  synthesizeTerminalRunEvents,
  testExports,
  toTerminalJobStatus,
  toTerminalRunError,
} from "./service";

function parseSseData(value: string) {
  assert.equal(value.startsWith("data: "), true);
  return JSON.parse(value.slice("data: ".length).trim()) as Record<
    string,
    unknown
  >;
}

function createRun(
  input: Partial<ChatThreadRunRecord> = {},
): ChatThreadRunRecord {
  const now = new Date(0).toISOString();
  return {
    id: "run-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    userMessageId: "user-message-1",
    assistantMessageId: "assistant-message-1",
    idempotencyKey: "sourceweft-web-run:run-1",
    mode: "send",
    jobId: "job-1",
    streamKey: "chat-run-events:run-1",
    status: "running",
    eventOffset: 0,
    requestJson: {},
    snapshotJson: {},
    errorCode: null,
    errorMessage: null,
    startedAt: now,
    heartbeatAt: now,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

test("terminal run error preserves failed code and message", () => {
  const error = toTerminalRunError(
    createRun({
      status: "failed",
      errorCode: "CHAT_RUN_START_FAILED",
      errorMessage: "Queue unavailable",
    }),
  );

  assert.equal(error?.statusCode, 500);
  assert.equal(error?.code, "CHAT_RUN_START_FAILED");
  assert.equal(error?.message, "Queue unavailable");
});

test("terminal run error maps cancelled runs to 499", () => {
  const error = toTerminalRunError(
    createRun({
      status: "cancelled",
      errorCode: null,
      errorMessage: null,
    }),
  );

  assert.equal(error?.statusCode, 499);
  assert.equal(error?.code, "CLIENT_CANCELLED");
  assert.equal(error?.message, "Chat run was cancelled");
});

test("terminal job status preserves failed and cancelled terminal states", () => {
  assert.equal(toTerminalJobStatus("completed"), "completed");
  assert.equal(toTerminalJobStatus("failed"), "failed");
  assert.equal(toTerminalJobStatus("cancelled"), "cancelled");
  assert.equal(toTerminalJobStatus("queued"), "cancelled");
  assert.equal(toTerminalJobStatus("cancel_requested"), "cancelled");
});

test("terminal attach fallback emits error and finish when Redis lacks terminal events", () => {
  const events = synthesizeTerminalRunEvents({
    run: createRun({
      status: "failed",
      errorCode: "CHAT_RUN_FAILED",
      errorMessage: "Model failed",
    }),
    sawErrorEvent: false,
  }).map(parseSseData);

  assert.deepEqual(events, [
    {
      type: "error",
      code: "CHAT_RUN_FAILED",
      error: "Model failed",
      userMessageId: "user-message-1",
      messageId: "assistant-message-1",
    },
    { type: "finish" },
  ]);
});

test("terminal attach fallback does not duplicate prior error event", () => {
  const events = synthesizeTerminalRunEvents({
    run: createRun({ status: "failed" }),
    sawErrorEvent: true,
  }).map(parseSseData);

  assert.deepEqual(events, [{ type: "finish" }]);
});

test("retrieval snapshot preserves string annIndexUsed", () => {
  assert.deepEqual(
    normalizeRetrievalSnapshot({
      embeddingProfileId: "embedding-profile-1",
      vectorStrategy: "ann_hnsw",
      annIndexUsed: "sources_embedding_hnsw_idx",
      citations: [{ citation: "c1" }],
    }),
    {
      embeddingProfileId: "embedding-profile-1",
      vectorStrategy: "ann_hnsw",
      annIndexUsed: "sources_embedding_hnsw_idx",
      citations: [{ citation: "c1" }],
      availableCitations: [{ citation: "c1" }],
    },
  );
});

test("stale active run uses heartbeat timestamp", () => {
  const now = Date.parse("2024-01-01T00:11:00.000Z");

  assert.equal(
    isStaleActiveRun(
      createRun({
        status: "running",
        heartbeatAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:10:30.000Z",
      }),
      now,
    ),
    true,
  );
  assert.equal(
    isStaleActiveRun(
      createRun({
        status: "running",
        heartbeatAt: "2024-01-01T00:09:30.000Z",
      }),
      now,
    ),
    false,
  );
});

test("queued run without job is stale after grace period", () => {
  const now = Date.parse("2024-01-01T00:00:11.000Z");

  assert.equal(
    isStaleActiveRun(
      createRun({
        status: "queued",
        jobId: null,
        userMessageId: null,
        assistantMessageId: null,
        createdAt: "2024-01-01T00:00:00.000Z",
      }),
      now,
    ),
    true,
  );
});

test("attach state fails stale running run and synthesizes terminal events", async () => {
  const staleRun = createRun({
    status: "running",
    heartbeatAt: "2024-01-01T00:00:00.000Z",
  });
  const failedRun = createRun({
    status: "failed",
    errorCode: "CHAT_RUN_STALE",
    errorMessage: "Previous chat run stopped unexpectedly.",
    finishedAt: "2024-01-01T00:11:00.000Z",
  });
  const failCalls: ChatThreadRunRecord[] = [];

  const result = await testExports.resolveAttachRunState({
    run: staleRun,
    offset: 0,
    sawErrorEvent: false,
    findRunById: async () => staleRun,
    failStaleRun: async (run) => {
      failCalls.push(run);
      return failedRun;
    },
    getEvents: async () => ({ events: [], nextOffset: 0 }),
  });

  assert.deepEqual(failCalls, [staleRun]);
  assert.equal(result.run.status, "failed");
  assert.deepEqual(result.terminalEvents?.map(parseSseData), [
    {
      type: "error",
      code: "CHAT_RUN_STALE",
      error: "Previous chat run stopped unexpectedly.",
      userMessageId: "user-message-1",
      messageId: "assistant-message-1",
    },
    { type: "finish" },
  ]);
});

test("result wait turns stale active run terminal before timeout", async () => {
  const staleRun = createRun({
    status: "running",
    heartbeatAt: "2024-01-01T00:00:00.000Z",
  });
  const failedRun = createRun({
    status: "failed",
    errorCode: "CHAT_RUN_STALE",
    errorMessage: "Previous chat run stopped unexpectedly.",
    finishedAt: "2024-01-01T00:11:00.000Z",
  });
  let failCalls = 0;

  await assert.rejects(
    testExports.waitForRunResult({
      run: staleRun,
      timeoutMs: 1_000,
      requireTerminal: true,
      throwTerminalErrors: true,
      failStaleRun: async () => {
        failCalls += 1;
        return failedRun;
      },
      findRunById: async () => failedRun,
    }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as { code?: string }).code, "CHAT_RUN_STALE");
      return true;
    },
  );

  assert.equal(failCalls, 1);
});
