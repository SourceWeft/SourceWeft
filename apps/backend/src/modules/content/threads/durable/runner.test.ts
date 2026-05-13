import assert from "node:assert/strict";
import test from "node:test";
import { ContentError } from "../../errors";
import type { ChatThreadRunRecord } from "./types";
import { persistTerminalFailure } from "./runner";

function createRun(): ChatThreadRunRecord {
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
  };
}

function parseSseData(value: string) {
  assert.equal(value.startsWith("data: "), true);
  return JSON.parse(value.slice("data: ".length).trim()) as Record<
    string,
    unknown
  >;
}

test("terminal failure persistence appends error and finish before marking run terminal", async () => {
  const order: string[] = [];
  const appendedPayloads: string[] = [];
  const run = createRun();

  await persistTerminalFailure({
    run,
    status: "failed",
    assistantMessageId: "assistant-message-1",
    snapshot: {
      errorCode: "CHAT_RUN_FAILED",
      errorMessage: "Model failed",
    },
    contentError: new ContentError(500, "CHAT_RUN_FAILED", "Model failed"),
    appendRunEvent: async (input) => {
      order.push(`append:${parseSseData(input.payload).type}`);
      appendedPayloads.push(input.payload);
    },
    finishRun: async () => {
      order.push("finish-run");
      return { ...run, status: "failed" };
    },
  });

  assert.deepEqual(order, ["append:error", "append:finish", "finish-run"]);
  assert.deepEqual(appendedPayloads.map(parseSseData), [
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
