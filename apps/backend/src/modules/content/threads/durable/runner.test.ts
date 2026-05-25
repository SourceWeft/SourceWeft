import assert from "node:assert/strict";
import { test } from "vitest";
import { ContentError } from "../../errors";
import type { ChatThreadRunRecord } from "./types";
import { persistTerminalFailure, testExports } from "./runner";

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

test("waiting approval metadata keeps confirmation and resume checkpoint", () => {
  const run = createRun({
    status: "waiting_for_approval",
  });

  const metadata = testExports.buildSnapshotMetadata({
    currentMetadata: {
      modelAlias: "gpt-5",
      staleValue: true,
    },
    run,
    snapshot: {
      finishReason: "tool_confirmation_requested",
      agentCheckpoint: {
        beforeInput: null,
        beforeAssistant: null,
        resume: {
          threadId: "agent-thread-1",
          checkpointId: "checkpoint-1",
        },
        final: null,
      },
      reasoning: "Need to ask for approval.",
      reasoningSegments: [
        {
          id: "reasoning-before-approval",
          text: "Need to ask for approval.",
          sequence: 1,
        },
      ],
      thinkingSteps: [
        {
          id: "thinking-before-approval",
          title: "Preparing approval",
          status: "completed",
          items: [],
          sequence: 2,
        },
      ],
      toolCalls: [
        {
          id: "tool-1",
          tool: "delete_notion_page",
          input: {},
          output: {
            type: "tool_confirmation_request",
            schemaVersion: 1,
            id: "action-1",
            status: "proposed",
          },
          status: "approval_requested",
        },
      ],
    },
  });

  assert.equal(metadata.finishReason, "tool_confirmation_requested");
  assert.equal(metadata.reasoning, "Need to ask for approval.");
  assert.deepEqual(metadata.reasoningSegments, [
    {
      id: "reasoning-before-approval",
      text: "Need to ask for approval.",
      sequence: 1,
    },
  ]);
  assert.deepEqual(metadata.thinkingSteps, [
    {
      id: "thinking-before-approval",
      title: "Preparing approval",
      status: "completed",
      items: [],
      sequence: 2,
    },
  ]);
  assert.deepEqual(metadata.agentCheckpoint, {
    beforeInput: null,
    beforeAssistant: null,
    resume: {
      threadId: "agent-thread-1",
      checkpointId: "checkpoint-1",
    },
    final: null,
  });
  assert.deepEqual(metadata.threadRun, {
    id: "run-1",
    idempotencyKey: "sourceweft-web-run:run-1",
    status: "waiting_for_approval",
    mode: "send",
    streamKey: "chat-run-events:run-1",
  });
  assert.deepEqual(
    (metadata.toolCalls as Array<{ output?: { id?: string } }>).map(
      (toolCall) => toolCall.output?.id,
    ),
    ["action-1"],
  );
});

test("finish snapshot captures agent checkpoint for approval resume", () => {
  const snapshot = testExports.updateSnapshotFromPayload(
    {},
    {
      type: "finish",
      finishReason: "tool_confirmation_requested",
      agentCheckpoint: {
        beforeInput: null,
        beforeAssistant: null,
        resume: {
          threadId: "agent-thread-1",
          checkpointId: "checkpoint-1",
        },
        final: null,
      },
    },
  );

  assert.equal(snapshot.finishReason, "tool_confirmation_requested");
  assert.deepEqual(snapshot.agentCheckpoint, {
    beforeInput: null,
    beforeAssistant: null,
    resume: {
      threadId: "agent-thread-1",
      checkpointId: "checkpoint-1",
    },
    final: null,
  });
});

test("approval continuation keeps the prepared assistant message id", () => {
  assert.equal(
    testExports.resolvePreparedAssistantMessageId({
      prepared: { assistantMessageId: "assistant-existing" },
      placeholderId: "assistant-placeholder",
    }),
    "assistant-existing",
  );

  assert.equal(
    testExports.resolvePreparedAssistantMessageId({
      prepared: { assistantMessageId: null },
      placeholderId: "assistant-placeholder",
    }),
    "assistant-placeholder",
  );
});

test("run snapshots replace reasoning updates for the same segment", () => {
  const firstSnapshot = testExports.updateSnapshotFromPayload(
    {},
    {
      type: "reasoning",
      reasoning: "before",
      segment: {
        id: "model-reasoning-1",
        text: "before",
        sequence: 1,
        phase: "initial",
      },
    },
  );
  const updatedFirstSnapshot = testExports.updateSnapshotFromPayload(
    firstSnapshot,
    {
      type: "reasoning",
      reasoning: " tool",
      segment: {
        id: "model-reasoning-1",
        text: "before tool",
        sequence: 1,
        phase: "initial",
      },
    },
  );
  const afterToolSnapshot = testExports.updateSnapshotFromPayload(
    updatedFirstSnapshot,
    {
      type: "reasoning",
      reasoning: "after",
      segment: {
        id: "model-reasoning-1",
        text: "after",
        sequence: 3,
        phase: "after_tool",
        toolCallId: "tool-1",
        tool: "search_notion_pages",
      },
    },
  );

  assert.equal(afterToolSnapshot.reasoning, "before toolafter");
  assert.deepEqual(
    (
      afterToolSnapshot.reasoningSegments as Array<{
        text: string;
        toolCallId?: string;
      }>
    ).map((segment) => ({
      text: segment.text,
      toolCallId: segment.toolCallId,
    })),
    [
      {
        text: "after",
        toolCallId: "tool-1",
      },
    ],
  );
});

test("run snapshots update streaming reasoning deltas in one trace part", () => {
  let snapshot = {};
  for (const text of ["The user", "The user wants", "The user wants TEST"]) {
    snapshot = testExports.updateSnapshotFromPayload(snapshot, {
      type: "reasoning",
      reasoning: text,
      segment: {
        id: "model-reasoning-1",
        text,
        sequence: 1,
        phase: "initial",
      },
    });
  }

  assert.deepEqual(
    (
      (snapshot as {
        reasoningSegments?: Array<{ id: string; text: string }>;
      }).reasoningSegments ?? []
    ).map((segment) => `${segment.id}:${segment.text}`),
    ["model-reasoning-1:The user wants TEST"],
  );
  assert.deepEqual(
    (
      (snapshot as {
        traceParts?: Array<{ kind: string; order: number; text?: string }>;
      }).traceParts ?? []
    ).map((part) => `${part.order}:${part.kind}:${part.text ?? ""}`),
    ["0:reasoning:The user wants TEST"],
  );
});

test("run snapshots keep append-only trace events by sequence", () => {
  const firstSnapshot = testExports.updateSnapshotFromPayload(
    {},
    {
      type: "reasoning",
      reasoning: "before",
      segment: {
        id: "model-reasoning-1",
        text: "before",
        sequence: 1,
        phase: "initial",
      },
    },
  );
  const toolSnapshot = testExports.updateSnapshotFromPayload(firstSnapshot, {
    type: "tool-call-result",
    id: "search-page",
    tool: "search_notion_pages",
    toolCall: {
      id: "search-page",
      tool: "search_notion_pages",
      input: {},
      output: null,
      status: "completed",
      sequence: 2,
    },
  });
  const afterToolSnapshot = testExports.updateSnapshotFromPayload(toolSnapshot, {
    type: "reasoning",
    reasoning: "after",
    segment: {
      id: "model-reasoning-1",
      text: "after",
      sequence: 3,
      phase: "after_tool",
      toolCallId: "search-page",
      tool: "search_notion_pages",
    },
  });

  assert.deepEqual(
    (
      afterToolSnapshot.traceEvents as Array<{
        id: string;
        sequence: number;
        type: string;
      }>
    ).map((event) => `${event.sequence}:${event.type}:${event.id}`),
    [
      "1:reasoning:model-reasoning-1:1",
      "2:tool-call:search-page:2",
      "3:reasoning:model-reasoning-1:3",
    ],
  );
});

test("final run resolution preserves externally terminalized cancellation", () => {
  const runningRun = createRun({ status: "running" });
  const cancelledRun = createRun({
    status: "cancelled",
    errorCode: "CLIENT_CANCELLED",
    errorMessage: "Chat run was cancelled",
  });

  const resolved = testExports.resolveFinalRunAfterFinish({
    finished: null,
    latest: cancelledRun,
    run: runningRun,
  });

  assert.equal(resolved.status, "cancelled");
  assert.equal(resolved.errorCode, "CLIENT_CANCELLED");
});
