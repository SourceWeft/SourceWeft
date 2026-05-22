import assert from "node:assert/strict";
import { test } from "vitest";
import type { ChatMessageItem } from "./streaming-assistant-state";
import { createStreamingRenderBuffer } from "./streaming-render-buffer";
import { testExports } from "./streaming-event-handlers";

test("finish event stores finish reason on the streaming assistant message", () => {
  let message: ChatMessageItem = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    contentJson: {},
    parentMessageId: null,
    metadata: {
      threadRun: {
        idempotencyKey: "sourceweft-web-run:run-1",
        mode: "send",
        status: "running",
      },
    },
    createdAt: new Date(0).toISOString(),
  };

  testExports.handleStreamingFinish({
    context: {
      appendReasoningChunk: (current, next) => `${current ?? ""}${next}`,
      durableRunKey: "sourceweft-web-run:run-1",
      isCompletedImageArtifactToolCall: () => false,
      isCompletedWorkfileWriteToolCall: () => false,
      isGeneratedImageArtifactToolName: () => false,
      mergeThinkingStepRecords: () => undefined,
      mode: "send",
      normalizeCitationRecords: () => [],
      normalizeModelReasoningSegmentRecord: () => null,
      normalizeThinkingStepRecord: () => null,
      normalizeThreadCommandRequest: () => undefined,
      resolveToolCallFromStreamEvent: () => {
        throw new Error("not used");
      },
      streamRenderBuffer: createStreamingRenderBuffer({
        maxDeltaBatchChars: 800,
      }),
      streamThinkingStepsById: new Map(),
      streamToolCallsById: new Map(),
      syncStreamingCitations: () => undefined,
      syncStreamingThinkingSteps: () => undefined,
      syncStreamingToolCalls: () => undefined,
      toNullableString: (value) => (typeof value === "string" ? value : null),
      toObjectRecord: (value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null,
      updateChatTitle: () => undefined,
      updateStreamingAssistantMessage: (updater) => {
        message = updater(message);
      },
    },
    finishReason: "tool_confirmation_requested",
  });

  assert.equal(message.metadata.finishReason, "tool_confirmation_requested");
  assert.deepEqual(message.metadata.threadRun, {
    idempotencyKey: "sourceweft-web-run:run-1",
    mode: "send",
    status: "completed",
  });
});

test("approval refresh assistant message keeps the original assistant root", () => {
  let message: ChatMessageItem = {
    id: "assistant-interrupted",
    role: "assistant",
    content: "Waiting for confirmation",
    contentJson: {},
    parentMessageId: null,
    metadata: {
      userMessageId: "user-1",
      sourceUserMessageId: "user-1",
      finishReason: "tool_confirmation_requested",
    },
    createdAt: new Date(0).toISOString(),
  };
  let persistedAssistantMessageId: string | null = null;
  let streamingAssistantMessageId = message.id;
  const streamingAssistantMessageIds = new Set<string>();

  testExports.handleStreamingAssistantMessage({
    context: {
      appendReasoningChunk: (current, next) => `${current ?? ""}${next}`,
      durableRunKey: "sourceweft-web-run:approval",
      isCompletedImageArtifactToolCall: () => false,
      isCompletedWorkfileWriteToolCall: () => false,
      isGeneratedImageArtifactToolName: () => false,
      mergeThinkingStepRecords: () => undefined,
      mode: "refresh",
      normalizeCitationRecords: () => [],
      normalizeModelReasoningSegmentRecord: () => null,
      normalizeThinkingStepRecord: () => null,
      normalizeThreadCommandRequest: () => undefined,
      resolveToolCallFromStreamEvent: () => {
        throw new Error("not used");
      },
      streamRenderBuffer: createStreamingRenderBuffer({
        maxDeltaBatchChars: 800,
      }),
      streamThinkingStepsById: new Map(),
      streamToolCallsById: new Map(),
      syncStreamingCitations: () => undefined,
      syncStreamingThinkingSteps: () => undefined,
      syncStreamingToolCalls: () => undefined,
      toNullableString: (value) => (typeof value === "string" ? value : null),
      toObjectRecord: (value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null,
      updateChatTitle: () => undefined,
      updateStreamingAssistantMessage: (updater) => {
        message = updater(message);
      },
    },
    messageId: "assistant-resumed",
    persistedUserMessageId: "user-1",
    setPersistedAssistantMessageId: (messageId) => {
      persistedAssistantMessageId = messageId;
    },
    setStreamingAssistantMessage: (nextMessage) => {
      message = nextMessage;
    },
    setStreamingAssistantMessageId: (messageId) => {
      streamingAssistantMessageId = messageId;
    },
    streamingAssistantMessage: message,
    streamingAssistantMessageId,
    streamingAssistantMessageIds,
    userMessageId: "user-1",
  });

  assert.equal(persistedAssistantMessageId, "assistant-resumed");
  assert.equal(streamingAssistantMessageId, "assistant-resumed");
  assert.equal(message.id, "assistant-resumed");
  assert.equal(message.parentMessageId, null);
  assert.equal(
    message.metadata.sourceAssistantMessageId,
    "assistant-interrupted",
  );
  assert.deepEqual([...streamingAssistantMessageIds], [
    "assistant-interrupted",
    "assistant-resumed",
  ]);
});
