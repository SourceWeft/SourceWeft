import assert from "node:assert/strict";
import { test } from "vitest";
import { ContentError } from "../../content/errors";
import { SANDBOX_EXECUTE_TOOL_CALL_ID_REQUIRED } from "../turn/sandbox-execute-error";
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
  let finishedUserMessageId: string | null | undefined;
  const run = createRun();

  await persistTerminalFailure({
    run,
    status: "failed",
    userMessageId: "user-message-override",
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
    finishRun: async (input) => {
      order.push("finish-run");
      finishedUserMessageId = input.userMessageId;
      return { ...run, status: "failed" };
    },
  });

  assert.deepEqual(order, ["append:error", "append:finish", "finish-run"]);
  assert.equal(finishedUserMessageId, "user-message-override");
  assert.deepEqual(appendedPayloads.map(parseSseData), [
    {
      type: "error",
      code: "CHAT_RUN_FAILED",
      error: "Model failed",
      userMessageId: "user-message-override",
      messageId: "assistant-message-1",
    },
    { type: "finish" },
  ]);
});

test("durable send and edit runs use stable internal message ids", () => {
  const send = createRun({ id: "run-send", mode: "send" });
  const edit = createRun({ id: "run-edit", mode: "edit" });
  const resume = createRun({ id: "run-resume", mode: "resume" });

  assert.deepEqual(
    testExports.requestWithDurableMessageOverrides({
      run: send,
      request: { content: "hello" } as never,
    }),
    {
      content: "hello",
      userMessageIdOverride: "run-user-run-send",
      assistantMessageIdOverride: "run-assistant-run-send",
    },
  );
  assert.deepEqual(
    testExports.requestWithDurableMessageOverrides({
      run: edit,
      request: { content: "edited" } as never,
    }),
    {
      content: "edited",
      userMessageIdOverride: "run-user-run-edit",
      assistantMessageIdOverride: "run-assistant-run-edit",
    },
  );
  assert.deepEqual(
    testExports.requestWithDurableMessageOverrides({
      run: resume,
      request: { content: "resume" } as never,
    }),
    { content: "resume" },
  );
});

test("durable failure fallback derives stable user message ids for send and edit only", () => {
  const send = createRun({ id: "run-send", mode: "send", userMessageId: null });
  const edit = createRun({ id: "run-edit", mode: "edit", userMessageId: null });
  const resume = createRun({
    id: "run-resume",
    mode: "resume",
    userMessageId: null,
  });

  assert.equal(
    testExports.durableUserMessageIdFallback({
      run: send,
      request: testExports.requestWithDurableMessageOverrides({
        run: send,
        request: { content: "hello" } as never,
      }),
    }),
    "run-user-run-send",
  );
  assert.equal(
    testExports.durableUserMessageIdFallback({
      run: edit,
      request: testExports.requestWithDurableMessageOverrides({
        run: edit,
        request: { content: "edited" } as never,
      }),
    }),
    "run-user-run-edit",
  );
  assert.equal(
    testExports.durableUserMessageIdFallback({
      run: resume,
      request: { mode: "resume" } as never,
    }),
    null,
  );
});

test("durable runner classifies LangChain sandbox execute approval errors", () => {
  const error = new Error("MiddlewareError", {
    cause: new Error(
      "SANDBOX_EXECUTE_TOOL_CALL_ID_REQUIRED: sandbox execute requires an approved stable tool call id from HITL resume metadata.",
    ),
  });

  const contentError = testExports.toDurableRunContentError(error);

  assert.equal(contentError.code, SANDBOX_EXECUTE_TOOL_CALL_ID_REQUIRED);
  assert.equal(contentError.statusCode, 403);
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
    assistantMessageId: "assistant-message-1",
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
      prepared: {
        assistantMessageId: "assistant-existing",
        assistantMessageIdOverride: null,
      },
      placeholderId: "assistant-placeholder",
    }),
    "assistant-existing",
  );

  assert.equal(
    testExports.resolvePreparedAssistantMessageId({
      prepared: { assistantMessageId: null, assistantMessageIdOverride: null },
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
      "1:reasoning:model-reasoning-1:1:initial:reasoning:0",
      "2:tool-call:search-page:2:tool-call-result:1",
      "3:reasoning:model-reasoning-1:3:after_tool:reasoning:2",
    ],
  );
});

test("run snapshots create tool trace parts from stable event payloads without toolCall", () => {
  const snapshot = testExports.updateSnapshotFromPayload(
    {},
    {
      type: "tool-call-event",
      id: "pptx-tool",
      tool: "publish_artifact",
      data: {
        type: "publish_artifact_progress",
        stage: "planning",
        title: "Quarterly review",
      },
    },
  );

  assert.deepEqual(snapshot.toolCalls, [
    {
      id: "pptx-tool",
      tool: "publish_artifact",
      input: {},
      output: {
        type: "publish_artifact_progress",
        stage: "planning",
        title: "Quarterly review",
      },
      status: "running",
      latencyMs: null,
      error: null,
    },
  ]);
  assert.deepEqual(
    (
      snapshot.traceParts as Array<{
        kind: string;
        toolCallId?: string;
        status?: string;
        output?: unknown;
      }>
    ).map((part) => ({
      kind: part.kind,
      toolCallId: part.toolCallId,
      status: part.status,
      output: part.output,
    })),
    [
      {
        kind: "tool",
        toolCallId: "pptx-tool",
        status: "running",
        output: {
          type: "publish_artifact_progress",
          stage: "planning",
          title: "Quarterly review",
        },
      },
    ],
  );
});

test("run snapshots keep separate tool trace events for start event result and end", () => {
  let snapshot = testExports.updateSnapshotFromPayload(
    {},
    {
      type: "tool-call-start",
      id: "search-page",
      tool: "search_sources",
      input: { query: "Q1" },
      toolCall: {
        id: "search-page",
        tool: "search_sources",
        input: { query: "Q1" },
        output: null,
        status: "running",
        latencyMs: null,
        error: null,
        sequence: 2,
      },
    },
  );
  snapshot = testExports.updateSnapshotFromPayload(snapshot, {
    type: "tool-call-event",
    id: "search-page",
    tool: "search_sources",
    data: { type: "search_progress", count: 3 },
  });
  snapshot = testExports.updateSnapshotFromPayload(snapshot, {
    type: "tool-call-result",
    id: "search-page",
    tool: "search_sources",
    output: { query: "Q1", hitCount: 3 },
    latencyMs: 42,
    toolCall: {
      id: "search-page",
      tool: "search_sources",
      input: { query: "Q1" },
      output: { query: "Q1", hitCount: 3 },
      status: "completed",
      latencyMs: 42,
      error: null,
      sequence: 2,
    },
  });
  snapshot = testExports.updateSnapshotFromPayload(snapshot, {
    type: "tool-call-end",
    id: "search-page",
    tool: "search_sources",
    status: "completed",
    latencyMs: 42,
    toolCall: {
      id: "search-page",
      tool: "search_sources",
      input: { query: "Q1" },
      output: { query: "Q1", hitCount: 3 },
      status: "completed",
      latencyMs: 42,
      error: null,
      sequence: 2,
    },
  });

  assert.deepEqual(
    (
      snapshot.traceEvents as Array<{
        eventType: string;
        id: string;
        itemId: string;
      }>
    ).map((event) => `${event.eventType}:${event.id}:${event.itemId}`),
    [
      "tool-call-start:search-page:2:tool-call-start:0:search-page",
      "tool-call-event:search-page:search_progress:tool-call-event:1:search-page",
      "tool-call-result:search-page:2:tool-call-result:2:search-page",
      "tool-call-end:search-page:2:tool-call-end:3:search-page",
    ],
  );
  assert.deepEqual(
    (
      snapshot.traceParts as Array<{
        kind: string;
        status?: string;
        toolCallId?: string;
      }>
    ).map((part) => `${part.kind}:${part.toolCallId}:${part.status}`),
    ["tool:search-page:completed"],
  );
});

test("run snapshots preserve streamed text render blocks", () => {
  const deltaSnapshot = testExports.updateSnapshotFromPayload(
    {},
    {
      type: "text-delta",
      delta: "First",
    },
  );
  const appendedSnapshot = testExports.updateSnapshotFromPayload(deltaSnapshot, {
    type: "text-delta",
    delta: " second",
  });
  const replacedSnapshot = testExports.updateSnapshotFromPayload(
    appendedSnapshot,
    {
      type: "text-replace",
      text: "Replacement",
    },
  );

  assert.equal(appendedSnapshot.assistantContent, "First second");
  assert.deepEqual(appendedSnapshot.renderBlocks, [
    {
      id: "text-1",
      type: "text",
      text: "First second",
    },
  ]);
  assert.deepEqual(replacedSnapshot.renderBlocks, [
    {
      id: "text-1",
      type: "text",
      text: "Replacement",
    },
  ]);
});

test("run snapshots preserve text segmentation on text replace", () => {
  const firstTextSnapshot = testExports.updateSnapshotFromPayload(
    {},
    {
      type: "text-delta",
      delta: "Found pages.",
    },
  );
  const toolSnapshot = testExports.updateSnapshotFromPayload(firstTextSnapshot, {
    type: "tool-call-start",
    id: "create-page",
    tool: "create_notion_page",
  });
  const secondTextSnapshot = testExports.updateSnapshotFromPayload(toolSnapshot, {
    type: "text-delta",
    delta: "Creation rejected.",
  });
  const replacedSnapshot = testExports.updateSnapshotFromPayload(
    secondTextSnapshot,
    {
      type: "text-replace",
      text: "Found pages.Creation rejected. Final summary.",
    },
  );

  assert.deepEqual(replacedSnapshot.renderBlocks, [
    {
      id: "text-1",
      type: "text",
      text: "Found pages.",
    },
    {
      id: "tool-create-page",
      type: "tool",
      toolCallId: "create-page",
    },
    {
      id: "text-3",
      type: "text",
      text: "Creation rejected. Final summary.",
    },
  ]);
});

test("run snapshots preserve generated artifact render blocks generically", () => {
  const textSnapshot = testExports.updateSnapshotFromPayload(
    {},
    {
      type: "text-delta",
      delta: "Here is the artifact:",
    },
  );
  const imageSnapshot = testExports.updateSnapshotFromPayload(textSnapshot, {
    type: "tool-call-start",
    id: "image-tool",
    tool: "generate_image",
    input: { prompt: "diagram" },
    toolCall: {
      id: "image-tool",
      tool: "generate_image",
      input: { prompt: "diagram" },
      output: null,
      status: "running",
      latencyMs: null,
      error: null,
      sequence: 1,
    },
  });
  const presentationSnapshot = testExports.updateSnapshotFromPayload(
    imageSnapshot,
    {
      type: "tool-call-event",
      id: "pptx-tool",
      tool: "publish_artifact",
      data: {
        type: "publish_artifact_progress",
        stage: "planning",
        toolCallId: "pptx-tool",
        title: "ASR",
      },
    },
  );
  const duplicatePresentationSnapshot = testExports.updateSnapshotFromPayload(
    presentationSnapshot,
    {
      type: "tool-call-start",
      id: "pptx-tool",
      tool: "publish_artifact",
    },
  );
  const searchSnapshotBeforePublish = testExports.updateSnapshotFromPayload(
    duplicatePresentationSnapshot,
    {
      type: "tool-call-start",
      id: "search-tool",
      tool: "search_sources",
    },
  );

  // Uniform: every artifact tool reconstructs a tool block (progress) plus a
  // terminal artifact block (result); a non-artifact tool gets only a tool
  // block. The deck artifact block appears as soon as the tool is seen, not
  // gated on publication.
  assert.deepEqual(searchSnapshotBeforePublish.renderBlocks, [
    {
      id: "text-1",
      type: "text",
      text: "Here is the artifact:",
    },
    {
      id: "tool-image-tool",
      type: "tool",
      toolCallId: "image-tool",
    },
    {
      id: "artifact-image-tool",
      placement: "terminal",
      type: "artifact",
      toolCallId: "image-tool",
    },
    {
      id: "artifact-pptx-tool",
      placement: "terminal",
      type: "artifact",
      toolCallId: "pptx-tool",
    },
    {
      id: "tool-pptx-tool",
      type: "tool",
      toolCallId: "pptx-tool",
    },
    {
      id: "tool-search-tool",
      type: "tool",
      toolCallId: "search-tool",
    },
  ]);
  const searchSnapshot = testExports.updateSnapshotFromPayload(
    searchSnapshotBeforePublish,
    {
      type: "tool-call-result",
      id: "pptx-tool",
      tool: "publish_artifact",
      output: {
        artifact_id: "artifact-1",
        artifact_url:
          "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
        status: "ready",
        title: "ASR",
      },
      latencyMs: 120,
      toolCall: {
        id: "pptx-tool",
        tool: "publish_artifact",
        input: {},
        output: {
          artifact_id: "artifact-1",
          artifact_url:
            "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
          status: "ready",
          title: "ASR",
        },
        status: "completed",
        latencyMs: 120,
        error: null,
      },
    },
  );

  // The deck's blocks already exist from when the tool first appeared, so its
  // completion adds nothing — the artifact block was never publication-gated.
  assert.deepEqual(searchSnapshot.renderBlocks, [
    {
      id: "text-1",
      type: "text",
      text: "Here is the artifact:",
    },
    {
      id: "tool-image-tool",
      type: "tool",
      toolCallId: "image-tool",
    },
    {
      id: "artifact-image-tool",
      placement: "terminal",
      type: "artifact",
      toolCallId: "image-tool",
    },
    {
      id: "artifact-pptx-tool",
      placement: "terminal",
      type: "artifact",
      toolCallId: "pptx-tool",
    },
    {
      id: "tool-pptx-tool",
      type: "tool",
      toolCallId: "pptx-tool",
    },
    {
      id: "tool-search-tool",
      type: "tool",
      toolCallId: "search-tool",
    },
  ]);
  assert.deepEqual(searchSnapshot.toolCalls, [
    {
      id: "image-tool",
      tool: "generate_image",
      input: { prompt: "diagram" },
      output: null,
      status: "running",
      latencyMs: null,
      error: null,
      sequence: 1,
    },
    {
      id: "search-tool",
      tool: "search_sources",
      input: {},
      output: null,
      status: "running",
      latencyMs: null,
      error: null,
    },
    {
      id: "pptx-tool",
      tool: "publish_artifact",
      input: {},
      output: {
        artifact_id: "artifact-1",
        artifact_url:
          "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
        stage: "planning",
        status: "ready",
        title: "ASR",
        toolCallId: "pptx-tool",
        type: "publish_artifact_progress",
      },
      status: "completed",
      latencyMs: 120,
      error: null,
    },
  ]);
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
