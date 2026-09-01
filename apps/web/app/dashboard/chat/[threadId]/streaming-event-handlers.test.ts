import assert from "node:assert/strict";
import { test } from "vitest";
import type { ModelReasoningSegmentRecord } from "../_components/chat-canvas";
import type { ChatMessageItem } from "./streaming-assistant-state";
import { createStreamingRenderBuffer } from "./streaming-render-buffer";
import {
  testExports,
  type StreamingEventHandlerContext,
  type ToolCallEventPayload,
} from "./streaming-event-handlers";

function createBaseStreamingContext(
  overrides: Partial<StreamingEventHandlerContext<ToolCallEventPayload>> = {},
): StreamingEventHandlerContext<ToolCallEventPayload> {
  return {
    appendReasoningChunk: (current, next) => `${current ?? ""}${next}`,
    durableRunKey: "sourceweft-web-run:run-1",
    isCompletedArtifactToolCall: () => false,
    isCompletedWorkfileWriteToolCall: () => false,
    mergeThinkingStepRecords: () => undefined,
    mode: "send",
    normalizeCitationRecords: () => [],
    normalizeModelReasoningSegmentRecord: () => null,
    normalizeThinkingStepRecord: () => null,
    normalizeThreadCommandRequest: () => undefined,
    resolveToolCallFromStreamEvent: () => {
      throw new Error("not used");
    },
    resolveTraceEventFromStreamEvent: () => null,
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
    updateStreamingAssistantMessage: () => undefined,
    ...overrides,
  };
}

function getToolEventData(event: ToolCallEventPayload) {
  return "data" in event ? event.data : undefined;
}

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
      isCompletedArtifactToolCall: () => false,
      isCompletedWorkfileWriteToolCall: () => false,
      mergeThinkingStepRecords: () => undefined,
      mode: "send",
      normalizeCitationRecords: () => [],
      normalizeModelReasoningSegmentRecord: () => null,
      normalizeThinkingStepRecord: () => null,
      normalizeThreadCommandRequest: () => undefined,
      resolveToolCallFromStreamEvent: () => {
        throw new Error("not used");
      },
      resolveTraceEventFromStreamEvent: () => null,
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
    status: "waiting_for_approval",
  });
});

test("finish event completes canonical thinking steps without rewriting trace metadata", () => {
  let message: ChatMessageItem = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    contentJson: {},
    parentMessageId: null,
    metadata: {
      traceEvents: [
        {
          type: "thinking-step",
          id: "step-1",
          itemId: "step-1",
          step: {
            id: "step-1",
            kind: "reasoning_summary",
            title: "Thinking",
            status: "in_progress",
            items: [],
            sequence: 0,
          },
        },
      ],
      threadRun: {
        idempotencyKey: "sourceweft-web-run:run-1",
        mode: "send",
        status: "running",
      },
    },
    createdAt: new Date(0).toISOString(),
  };
  const context = createBaseStreamingContext({
    streamThinkingStepsById: new Map([
      [
        "step-1",
        {
          id: "step-1",
          kind: "reasoning_summary",
          title: "Thinking",
          status: "in_progress",
          items: [],
          sequence: 0,
        },
      ],
    ]),
    updateStreamingAssistantMessage: (updater) => {
      message = updater(message);
    },
  });

  testExports.handleStreamingFinish({
    context,
    finishReason: undefined,
  });

  assert.equal(message.metadata.finishReason, "stop");
  assert.deepEqual(message.metadata.threadRun, {
    idempotencyKey: "sourceweft-web-run:run-1",
    mode: "send",
    status: "completed",
  });
  assert.equal(
    (
      message.metadata.thinkingSteps as Array<{ id: string; status: string }>
    ).find((step) => step.id === "step-1")?.status,
    "completed",
  );
  assert.equal(
    (
      message.metadata.traceEvents as Array<{
        type: string;
        step?: { id: string; status: string };
      }>
    ).find((event) => event.step?.id === "step-1")?.step?.status,
    "in_progress",
  );
  assert.equal(message.metadata.traceParts, undefined);
});

test("streaming DeepAgents todo step updates trace parts without tool trace", () => {
  let message: ChatMessageItem = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    contentJson: {},
    parentMessageId: null,
    metadata: {},
    createdAt: new Date(0).toISOString(),
  };
  const streamThinkingStepsById = new Map();
  const context = createBaseStreamingContext({
    mergeThinkingStepRecords: (stepsById, nextStep) => {
      stepsById.set(nextStep.id, nextStep);
    },
    normalizeThinkingStepRecord: (value) => {
      const record =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
      if (
        typeof record?.id !== "string" ||
        typeof record.title !== "string" ||
        (record.status !== "pending" &&
          record.status !== "in_progress" &&
          record.status !== "completed")
      ) {
        return null;
      }
      return {
        id: record.id,
        kind: record.kind === "state" ? "state" : undefined,
        title: record.title,
        status: record.status,
        items: Array.isArray(record.items)
          ? record.items.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
        sequence:
          typeof record.sequence === "number" ? record.sequence : undefined,
        metadata:
          record.metadata &&
          typeof record.metadata === "object" &&
          !Array.isArray(record.metadata)
            ? (record.metadata as Record<string, unknown>)
            : undefined,
      };
    },
    streamThinkingStepsById,
    syncStreamingThinkingSteps: () => undefined,
    updateStreamingAssistantMessage: (updater) => {
      message = updater(message);
    },
  });

  testExports.handleStreamingThinkingStep({
    context,
    step: {
      id: "deepagents:todos",
      kind: "state",
      title: "Task plan",
      status: "in_progress",
      items: ["In progress: Surface todos in trace"],
      sequence: 1,
      metadata: {
        source: "deepagents",
        tool: "write_todos",
        toolCallId: "call-todos",
        todos: [
          {
            content: "Surface todos in trace",
            status: "in_progress",
          },
        ],
      },
    },
  });

  assert.equal(streamThinkingStepsById.has("deepagents:todos"), true);
  assert.deepEqual(
    (
      message.metadata.traceParts as Array<{
        id: string;
        kind: string;
        tool?: string;
      }>
    )
      .filter((part) => part.id === "deepagents:todos")
      .map((part) => part.kind),
    ["step"],
  );
  assert.equal(
    (
      message.metadata.traceParts as Array<{ kind: string; tool?: string }>
    ).some((part) => part.kind === "tool" && part.tool === "write_todos"),
    false,
  );
});

test("finish status marks tool confirmation pauses as waiting for approval", () => {
  assert.equal(
    testExports.resolveFinishedThreadRunStatus({
      existingStatus: "running",
      finishReason: "tool_confirmation_requested",
    }),
    "waiting_for_approval",
  );
  assert.equal(
    testExports.resolveFinishedThreadRunStatus({
      existingStatus: "running",
      finishReason: "stop",
    }),
    "completed",
  );
  assert.equal(
    testExports.resolveFinishedThreadRunStatus({
      existingStatus: "failed",
      finishReason: "tool_confirmation_requested",
    }),
    "failed",
  );
});

test("streaming errors hide raw tool kwargs and schema details", () => {
  const rawError =
    'Error invoking tool \'publish_artifact\' with kwargs {"brief":"x","slides":[{"kind":"title"}]} with error: Error: Received tool input did not match expected schema\n\n✖ Invalid input: expected string, received undefined\n  → at title';
  const captured: {
    markedError?: {
      code?: string | null;
      error: string;
      messageId?: string | null;
      userMessageId?: string | null;
    };
    streamError?: Error;
    suppressErrorToast?: boolean;
  } = {};

  testExports.handleStreamingError({
    event: {
      code: "MODEL_UPSTREAM_ERROR",
      error: rawError,
      messageId: "assistant-error",
    },
    markStreamingAssistantAsError: (errorInput) => {
      captured.markedError = errorInput;
    },
    persistedUserMessageId: "user-1",
    setStreamError: (error) => {
      captured.streamError = error;
    },
    setSuppressErrorToast: (value) => {
      captured.suppressErrorToast = value;
    },
  });

  const expected =
    "publish_artifact failed because the generated tool arguments were invalid. Please retry.";
  assert.equal(captured.markedError?.error, expected);
  assert.equal(captured.streamError?.message, expected);
  assert.equal(captured.suppressErrorToast, false);
  assert.doesNotMatch(
    captured.markedError?.error ?? "",
    /kwargs|schema|brief|slides/i,
  );
});

test("finish event preserves approval requested tool calls", () => {
  let message: ChatMessageItem = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    contentJson: {},
    parentMessageId: null,
    metadata: {},
    createdAt: new Date(0).toISOString(),
  };
  const streamToolCallsById = new Map([
    [
      "tool-1",
      {
        id: "tool-1",
        tool: "delete_notion_page",
        input: {},
        output: {
          type: "tool_confirmation_request",
          schemaVersion: 1,
          id: "action-1",
          domain: "connector",
          subject: {
            label: "Lei Qin",
            provider: "notion",
            connectorId: "connector-1",
          },
          action: {
            type: "notion.page.trash",
            toolName: "delete_notion_page",
            label: "Delete",
            riskLevel: "high",
            status: "proposed",
            requiresApproval: true,
          },
          preview: {
            title: "Delete Notion page: Referenced",
          },
          decisionOptions: [
            { decision: "reject", label: "Reject" },
            { decision: "approve", label: "Approve" },
          ],
          execution: {
            providerStatus: "not_executed",
            executor: {
              kind: "connector_action_run",
              connectorId: "connector-1",
              actionRunId: "action-1",
            },
          },
          status: "proposed",
          userMessage: "Waiting for confirmation.",
        },
        status: "approval_requested" as const,
        latencyMs: 0,
        error: null,
      },
    ],
  ]);
  let syncedToolCalls: unknown[] = [];

  testExports.handleStreamingFinish({
    context: {
      appendReasoningChunk: (current, next) => `${current ?? ""}${next}`,
      durableRunKey: "sourceweft-web-run:run-1",
      isCompletedArtifactToolCall: () => false,
      isCompletedWorkfileWriteToolCall: () => false,
      mergeThinkingStepRecords: () => undefined,
      mode: "send",
      normalizeCitationRecords: () => [],
      normalizeModelReasoningSegmentRecord: () => null,
      normalizeThinkingStepRecord: () => null,
      normalizeThreadCommandRequest: () => undefined,
      resolveToolCallFromStreamEvent: () => {
        throw new Error("not used");
      },
      resolveTraceEventFromStreamEvent: () => null,
      streamRenderBuffer: createStreamingRenderBuffer({
        maxDeltaBatchChars: 800,
      }),
      streamThinkingStepsById: new Map(),
      streamToolCallsById,
      syncStreamingCitations: () => undefined,
      syncStreamingThinkingSteps: () => undefined,
      syncStreamingToolCalls: () => {
        syncedToolCalls = [...streamToolCallsById.values()];
      },
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

  assert.equal(streamToolCallsById.get("tool-1")?.status, "approval_requested");
  assert.equal(
    (syncedToolCalls[0] as { status?: string } | undefined)?.status,
    "approval_requested",
  );
  assert.equal(message.metadata.finishReason, "tool_confirmation_requested");
});

test("finish event completes canonical tool calls without rewriting trace parts", () => {
  let message: ChatMessageItem = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    contentJson: {},
    parentMessageId: null,
    metadata: {
      traceParts: [
        {
          id: "tool-1",
          kind: "tool",
          order: 0,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          toolCallId: "tool-1",
          tool: "publish_artifact",
          status: "running",
          input: {},
          output: null,
          error: null,
          latencyMs: null,
        },
      ],
      threadRun: {
        idempotencyKey: "sourceweft-web-run:run-1",
        mode: "send",
        status: "running",
      },
    },
    createdAt: new Date(0).toISOString(),
  };
  const streamToolCallsById = new Map([
    [
      "tool-1",
      {
        id: "tool-1",
        tool: "publish_artifact",
        input: {},
        output: null,
        status: "running" as const,
        latencyMs: null,
        error: null,
      },
    ],
  ]);

  testExports.handleStreamingFinish({
    context: createBaseStreamingContext({
      streamToolCallsById,
      updateStreamingAssistantMessage: (updater) => {
        message = updater(message);
      },
    }),
    finishReason: undefined,
  });

  assert.equal(streamToolCallsById.get("tool-1")?.status, "completed");
  assert.equal(
    (message.metadata.toolCalls as Array<{ id: string; status: string }>).find(
      (toolCall) => toolCall.id === "tool-1",
    )?.status,
    "completed",
  );
  assert.equal(
    (message.metadata.traceParts as Array<{ id: string; status: string }>).find(
      (part) => part.id === "tool-1",
    )?.status,
    "running",
  );
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
      isCompletedArtifactToolCall: () => false,
      isCompletedWorkfileWriteToolCall: () => false,
      mergeThinkingStepRecords: () => undefined,
      mode: "refresh",
      normalizeCitationRecords: () => [],
      normalizeModelReasoningSegmentRecord: () => null,
      normalizeThinkingStepRecord: () => null,
      normalizeThreadCommandRequest: () => undefined,
      resolveToolCallFromStreamEvent: () => {
        throw new Error("not used");
      },
      resolveTraceEventFromStreamEvent: () => null,
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
  assert.equal(
    (message.metadata.threadRun as { status?: string } | undefined)?.status,
    "running",
  );
  assert.equal(
    (message.metadata.threadRun as { assistantMessageId?: string } | undefined)
      ?.assistantMessageId,
    "assistant-resumed",
  );
  assert.deepEqual(
    [...streamingAssistantMessageIds],
    ["assistant-interrupted", "assistant-resumed"],
  );
});

test("streaming reasoning keeps interrupted model reasoning in separate segments", () => {
  let message: ChatMessageItem = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    contentJson: {},
    parentMessageId: null,
    metadata: {},
    createdAt: new Date(0).toISOString(),
  };
  const normalizeModelReasoningSegmentRecord = (
    value: unknown,
    fallbackSequence = 0,
  ): ModelReasoningSegmentRecord | null => {
    const record =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    const text = typeof record?.text === "string" ? record.text.trim() : "";
    if (!record || !text) {
      return null;
    }

    return {
      id:
        typeof record.id === "string"
          ? record.id
          : `model-reasoning-${fallbackSequence + 1}`,
      text,
      sequence:
        typeof record.sequence === "number"
          ? record.sequence
          : fallbackSequence,
      durationMs:
        typeof record.durationMs === "number" ? record.durationMs : undefined,
      phase:
        record.phase === "initial" || record.phase === "after_tool"
          ? record.phase
          : undefined,
      toolCallId:
        typeof record.toolCallId === "string" ? record.toolCallId : undefined,
      tool: typeof record.tool === "string" ? record.tool : undefined,
    };
  };
  const context = {
    appendReasoningChunk: (current: string | undefined, next: string) =>
      `${current ?? ""}${next}`,
    durableRunKey: "sourceweft-web-run:run-1",
    isCompletedArtifactToolCall: () => false,
    isCompletedWorkfileWriteToolCall: () => false,
    mergeThinkingStepRecords: () => undefined,
    mode: "send" as const,
    normalizeCitationRecords: () => [],
    normalizeModelReasoningSegmentRecord,
    normalizeThinkingStepRecord: () => null,
    normalizeThreadCommandRequest: () => undefined,
    resolveToolCallFromStreamEvent: () => {
      throw new Error("not used");
    },
    resolveTraceEventFromStreamEvent: () => null,
    streamRenderBuffer: createStreamingRenderBuffer({
      maxDeltaBatchChars: 800,
    }),
    streamThinkingStepsById: new Map(),
    streamToolCallsById: new Map(),
    syncStreamingCitations: () => undefined,
    syncStreamingThinkingSteps: () => undefined,
    syncStreamingToolCalls: () => undefined,
    toNullableString: (value: unknown) =>
      typeof value === "string" ? value : null,
    toObjectRecord: (value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null,
    updateChatTitle: () => undefined,
    updateStreamingAssistantMessage: (
      updater: (current: ChatMessageItem) => ChatMessageItem,
    ) => {
      message = updater(message);
    },
  };

  testExports.handleStreamingReasoning({
    context,
    reasoning: "before tool",
    segment: {
      id: "model-reasoning:run-1:1",
      text: "before tool",
      sequence: 1,
      phase: "initial",
    },
  });
  testExports.handleStreamingReasoning({
    context,
    reasoning: " after tool",
    segment: {
      id: "model-reasoning:run-1:1",
      text: "after tool",
      sequence: 3,
      phase: "after_tool",
      toolCallId: "tool-1",
      tool: "search_notion_pages",
    },
  });

  assert.equal(message.metadata.reasoning, "before tool after tool");
  assert.deepEqual(
    (
      message.metadata.reasoningSegments as Array<{
        id: string;
        text: string;
        toolCallId?: string;
      }>
    ).map((segment) => ({
      id: segment.id,
      text: segment.text,
      toolCallId: segment.toolCallId,
    })),
    [
      {
        id: "model-reasoning:run-1:1",
        text: "after tool",
        toolCallId: "tool-1",
      },
    ],
  );
});

test("streaming reasoning deltas update one stable trace part", () => {
  let message: ChatMessageItem = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    contentJson: {},
    parentMessageId: null,
    metadata: {},
    createdAt: new Date(0).toISOString(),
  };
  const context = {
    appendReasoningChunk: (current: string | undefined, next: string) =>
      current ? `${current}${next}` : next,
    durableRunKey: "sourceweft-web-run:run-1",
    isCompletedArtifactToolCall: () => false,
    isCompletedWorkfileWriteToolCall: () => false,
    mergeThinkingStepRecords: () => undefined,
    mode: "send" as const,
    normalizeCitationRecords: () => [],
    normalizeModelReasoningSegmentRecord: (value: unknown) => {
      const record =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
      const text = typeof record?.text === "string" ? record.text : "";
      if (!record || !text) {
        return null;
      }
      return {
        id: typeof record.id === "string" ? record.id : "reasoning-1",
        text,
        sequence:
          typeof record.sequence === "number" ? record.sequence : undefined,
        phase: record.phase === "initial" ? "initial" : undefined,
      } satisfies ModelReasoningSegmentRecord;
    },
    normalizeThinkingStepRecord: () => null,
    normalizeThreadCommandRequest: () => undefined,
    resolveToolCallFromStreamEvent: () => {
      throw new Error("not used");
    },
    resolveTraceEventFromStreamEvent: () => null,
    streamRenderBuffer: createStreamingRenderBuffer({
      maxDeltaBatchChars: 800,
    }),
    streamThinkingStepsById: new Map(),
    streamToolCallsById: new Map(),
    syncStreamingCitations: () => undefined,
    syncStreamingThinkingSteps: () => undefined,
    syncStreamingToolCalls: () => undefined,
    toNullableString: (value: unknown) =>
      typeof value === "string" ? value : null,
    toObjectRecord: (value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null,
    updateChatTitle: () => undefined,
    updateStreamingAssistantMessage: (
      updater: (current: ChatMessageItem) => ChatMessageItem,
    ) => {
      message = updater(message);
    },
  };

  for (const text of ["用户", "想要", "创建页面"]) {
    testExports.handleStreamingReasoning({
      context,
      reasoning: text,
      segment: {
        id: "reasoning-1",
        sequence: 1,
        phase: "initial",
      },
    });
  }

  assert.deepEqual(
    (
      message.metadata.traceParts as Array<{
        kind: string;
        order: number;
        text?: string;
      }>
    ).map((part) => `${part.order}:${part.kind}:${part.text ?? ""}`),
    ["0:reasoning:用户想要创建页面"],
  );
  assert.deepEqual(
    (
      message.metadata.reasoningSegments as Array<{
        id: string;
        text: string;
      }>
    ).map((segment) => `${segment.id}:${segment.text}`),
    ["reasoning-1:用户想要创建页面"],
  );
  assert.deepEqual(
    (
      message.metadata.renderBlocks as Array<{
        id: string;
        text: string;
        type: string;
      }>
    ).map((block) => `${block.id}:${block.type}:${block.text}`),
    ["stream-reasoning-reasoning-1:reasoning:用户想要创建页面"],
  );
});

test("streaming delta-only reasoning starts a new segment when context changes", () => {
  let message: ChatMessageItem = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    contentJson: {},
    parentMessageId: null,
    metadata: {},
    createdAt: new Date(0).toISOString(),
  };
  const context = createBaseStreamingContext({
    appendReasoningChunk: (current, next) => `${current ?? ""}${next}`,
    normalizeModelReasoningSegmentRecord: (value: unknown) => {
      const record =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
      const text = typeof record?.text === "string" ? record.text.trim() : "";
      if (!record || !text) {
        return null;
      }
      return {
        id: typeof record.id === "string" ? record.id : "reasoning-1",
        text,
        sequence:
          typeof record.sequence === "number" ? record.sequence : undefined,
        phase:
          record.phase === "initial" || record.phase === "after_tool"
            ? record.phase
            : undefined,
        toolCallId:
          typeof record.toolCallId === "string" ? record.toolCallId : undefined,
        tool: typeof record.tool === "string" ? record.tool : undefined,
      } satisfies ModelReasoningSegmentRecord;
    },
    updateStreamingAssistantMessage: (updater) => {
      message = updater(message);
    },
  });

  testExports.handleStreamingReasoning({
    context,
    reasoning: "before",
    segment: {
      id: "reasoning-1",
      sequence: 1,
      phase: "initial",
    },
  });
  testExports.handleStreamingReasoning({
    context,
    reasoning: " tool",
    segment: {
      id: "reasoning-1",
      sequence: 1,
      phase: "initial",
    },
  });
  testExports.handleStreamingReasoning({
    context,
    reasoning: " after",
    segment: {
      id: "reasoning-1",
      sequence: 3,
      phase: "after_tool",
      toolCallId: "tool-1",
      tool: "search_sources",
    },
  });

  assert.equal(message.metadata.reasoning, "before tool after");
  assert.deepEqual(
    (
      message.metadata.reasoningSegments as Array<{
        id: string;
        text: string;
        toolCallId?: string;
      }>
    ).map((segment) => ({
      id: segment.id,
      text: segment.text,
      toolCallId: segment.toolCallId,
    })),
    [
      {
        id: "reasoning-1",
        text: "after",
        toolCallId: "tool-1",
      },
    ],
  );
  assert.deepEqual(
    (
      message.metadata.traceParts as Array<{
        kind: string;
        order: number;
        text?: string;
        toolCallId?: string;
      }>
    ).map(
      (part) =>
        `${part.order}:${part.kind}:${part.toolCallId ?? ""}:${part.text ?? ""}`,
    ),
    ["0:reasoning:tool-1:after"],
  );
});

test("streaming trace events preserve live display order across tools and reasoning", () => {
  let message: ChatMessageItem = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    contentJson: {},
    parentMessageId: null,
    metadata: {},
    createdAt: new Date(0).toISOString(),
  };
  const streamToolCallsById = new Map<
    string,
    {
      id: string;
      tool: string;
      input: Record<string, unknown>;
      output: unknown;
      latencyMs: number | null;
      status: "running" | "approval_requested" | "completed" | "error";
      error: string | null;
      sequence?: number;
    }
  >();
  const context = {
    appendReasoningChunk: (current: string | undefined, next: string) =>
      `${current ?? ""}${next}`,
    durableRunKey: "sourceweft-web-run:run-1",
    isCompletedArtifactToolCall: () => false,
    isCompletedWorkfileWriteToolCall: () => false,
    mergeThinkingStepRecords: () => undefined,
    mode: "send" as const,
    normalizeCitationRecords: () => [],
    normalizeModelReasoningSegmentRecord: (value: unknown) => {
      const record =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
      const text = typeof record?.text === "string" ? record.text : "";
      if (!record || !text) {
        return null;
      }
      const phase: ModelReasoningSegmentRecord["phase"] =
        record.phase === "initial" || record.phase === "after_tool"
          ? record.phase
          : undefined;
      return {
        id: typeof record.id === "string" ? record.id : "model-reasoning",
        text,
        sequence:
          typeof record.sequence === "number" ? record.sequence : undefined,
        phase,
        toolCallId:
          typeof record.toolCallId === "string" ? record.toolCallId : undefined,
        tool: typeof record.tool === "string" ? record.tool : undefined,
      };
    },
    normalizeThinkingStepRecord: () => null,
    normalizeThreadCommandRequest: () => undefined,
    resolveToolCallFromStreamEvent: ({
      event,
    }: {
      event: { id?: string; type: string };
    }) => {
      const id = event.id ?? "tool-1";
      const sequence = id === "search-tool" ? 2 : 4;
      return {
        id,
        tool:
          id === "search-tool" ? "search_notion_pages" : "create_notion_page",
        input: {},
        output: null,
        latencyMs: 10,
        status: "completed" as const,
        error: null,
        sequence,
      };
    },
    resolveTraceEventFromStreamEvent: ({
      event,
      toolCall,
    }: {
      event: { type: string };
      toolCall: {
        id: string;
        tool: string;
        sequence?: number;
      };
    }) => ({
      type: "tool-call" as const,
      id:
        typeof toolCall.sequence === "number"
          ? `${toolCall.id}:${toolCall.sequence}`
          : toolCall.id,
      itemId: toolCall.id,
      sequence: toolCall.sequence,
      eventType: event.type,
      tool: toolCall.tool,
      toolCall: {
        ...toolCall,
        input: {},
        output: null,
        latencyMs: 10,
        status: "completed" as const,
        error: null,
      },
      payload: event,
    }),
    streamRenderBuffer: createStreamingRenderBuffer({
      maxDeltaBatchChars: 800,
    }),
    streamThinkingStepsById: new Map(),
    streamToolCallsById,
    syncStreamingCitations: () => undefined,
    syncStreamingThinkingSteps: () => undefined,
    syncStreamingToolCalls: () => undefined,
    toNullableString: (value: unknown) =>
      typeof value === "string" ? value : null,
    toObjectRecord: (value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null,
    updateChatTitle: () => undefined,
    updateStreamingAssistantMessage: (
      updater: (current: ChatMessageItem) => ChatMessageItem,
    ) => {
      message = updater(message);
    },
  };

  testExports.handleStreamingReasoning({
    context,
    reasoning: "initial",
    segment: {
      id: "reasoning-1",
      text: "initial",
      sequence: 1,
      phase: "initial",
    },
  });
  testExports.handleStreamingToolCallEvent({
    context,
    drainQueuedDeltasNow: () => undefined,
    event: {
      type: "tool-call-result",
      id: "search-tool",
    },
    refreshedArtifactToolIds: new Set(),
    refreshedWorkfileToolIds: new Set(),
    setArtifactsRefreshKey: () => undefined,
    setWorkfilesRefreshKey: () => undefined,
  });
  testExports.handleStreamingToolCallEvent({
    context,
    drainQueuedDeltasNow: () => undefined,
    event: {
      type: "tool-call-result",
      id: "create-tool",
    },
    refreshedArtifactToolIds: new Set(),
    refreshedWorkfileToolIds: new Set(),
    setArtifactsRefreshKey: () => undefined,
    setWorkfilesRefreshKey: () => undefined,
  });
  testExports.handleStreamingReasoning({
    context,
    reasoning: "after search",
    segment: {
      id: "reasoning-2",
      text: "after search",
      sequence: 3,
      phase: "after_tool",
      toolCallId: "search-tool",
    },
  });

  assert.deepEqual(
    (
      message.metadata.traceParts as Array<{
        kind: string;
        order: number;
        text?: string;
        toolCallId?: string;
        status?: string;
      }>
    ).map(
      (part) =>
        `${part.order}:${part.kind}:${part.toolCallId ?? ""}:${part.status ?? ""}:${part.text ?? ""}`,
    ),
    [
      "0:reasoning:::initial",
      "1:tool:search-tool:completed:",
      "2:tool:create-tool:completed:",
      "3:reasoning:search-tool::after search",
    ],
  );
});

test("presentation artifact tool calls render progress and refresh after commit", () => {
  let message: ChatMessageItem = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    contentJson: {},
    parentMessageId: null,
    metadata: {},
    createdAt: new Date(0).toISOString(),
  };
  const streamToolCallsById = new Map<
    string,
    {
      id: string;
      tool: string;
      input: Record<string, unknown>;
      output: unknown;
      latencyMs: number | null;
      status: "running" | "approval_requested" | "completed" | "error";
      error: string | null;
    }
  >();
  const streamRenderBuffer = createStreamingRenderBuffer({
    maxDeltaBatchChars: 800,
  });
  let refreshCount = 0;
  let drainCount = 0;
  const context = createBaseStreamingContext({
    isCompletedArtifactToolCall: (toolCall, event) =>
      toolCall.tool === "publish_artifact" &&
      toolCall.status === "completed" &&
      event.type === "tool-call-result",
    resolveToolCallFromStreamEvent: ({ event, streamToolCallsById }) => {
      const existing = streamToolCallsById.get(event.id ?? "pptx-tool");
      const eventData = getToolEventData(event);
      return {
        id: event.id ?? "pptx-tool",
        tool: "publish_artifact",
        input: { title: "费曼学习法" },
        output:
          event.type === "tool-call-result"
            ? {
                ...(existing?.output &&
                typeof existing.output === "object" &&
                !Array.isArray(existing.output)
                  ? existing.output
                  : {}),
                artifact_id: "artifact-1",
                artifact_url:
                  "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
                title: "费曼学习法",
              }
            : event.type === "tool-call-event"
              ? {
                  ...(existing?.output &&
                  typeof existing.output === "object" &&
                  !Array.isArray(existing.output)
                    ? existing.output
                    : {}),
                  ...(eventData &&
                  typeof eventData === "object" &&
                  !Array.isArray(eventData)
                    ? eventData
                    : {}),
                }
              : (existing?.output ?? null),
        latencyMs: event.type === "tool-call-result" ? 10 : null,
        status: event.type === "tool-call-result" ? "completed" : "running",
        error: null,
      };
    },
    streamRenderBuffer,
    streamToolCallsById,
    syncStreamingToolCalls: () => {
      message = {
        ...message,
        metadata: {
          ...message.metadata,
          renderBlocks: streamRenderBuffer.snapshotRenderBlocks(),
          toolCalls: [...streamToolCallsById.values()],
        },
      };
    },
    updateStreamingAssistantMessage: (updater) => {
      message = updater(message);
    },
  });
  const refreshedArtifactToolIds = new Set<string>();

  testExports.handleStreamingToolCallEvent({
    context,
    drainQueuedDeltasNow: () => {
      drainCount += 1;
    },
    event: {
      type: "tool-call-event",
      id: "pptx-tool",
      data: {
        type: "publish_artifact_progress",
        toolCallId: "pptx-tool",
        stage: "planning",
        title: "费曼学习法",
      },
    },
    refreshedArtifactToolIds,
    refreshedWorkfileToolIds: new Set(),
    setArtifactsRefreshKey: (updater) => {
      refreshCount = updater(refreshCount);
    },
    setWorkfilesRefreshKey: () => undefined,
  });

  assert.equal(drainCount, 0);
  assert.equal(refreshCount, 0);
  assert.deepEqual(message.metadata.renderBlocks, []);
  assert.deepEqual(streamToolCallsById.get("pptx-tool")?.output, {
    type: "publish_artifact_progress",
    toolCallId: "pptx-tool",
    stage: "planning",
    title: "费曼学习法",
  });

  testExports.handleStreamingToolCallEvent({
    context,
    drainQueuedDeltasNow: () => {
      drainCount += 1;
    },
    event: {
      type: "tool-call-start",
      id: "pptx-tool",
    },
    refreshedArtifactToolIds,
    refreshedWorkfileToolIds: new Set(),
    setArtifactsRefreshKey: (updater) => {
      refreshCount = updater(refreshCount);
    },
    setWorkfilesRefreshKey: () => undefined,
  });

  // Tool start appends progress only; committed artifact output is delivered
  // separately by the publisher-owned result path.
  assert.equal(drainCount, 1);
  assert.deepEqual(message.metadata.renderBlocks, [
    {
      id: "stream-tool-pptx-tool",
      type: "tool",
      toolCallId: "pptx-tool",
    },
  ]);

  testExports.handleStreamingToolCallEvent({
    context,
    drainQueuedDeltasNow: () => {
      drainCount += 1;
    },
    event: {
      type: "tool-call-result",
      id: "pptx-tool",
    },
    refreshedArtifactToolIds,
    refreshedWorkfileToolIds: new Set(),
    setArtifactsRefreshKey: (updater) => {
      refreshCount = updater(refreshCount);
    },
    setWorkfilesRefreshKey: () => undefined,
  });

  // Tool result refreshes the artifact library but cannot infer a result block.
  assert.equal(drainCount, 1);
  assert.equal(refreshCount, 1);
  assert.deepEqual(message.metadata.renderBlocks, [
    {
      id: "stream-tool-pptx-tool",
      type: "tool",
      toolCallId: "pptx-tool",
    },
  ]);
  assert.deepEqual(streamToolCallsById.get("pptx-tool")?.output, {
    type: "publish_artifact_progress",
    toolCallId: "pptx-tool",
    stage: "planning",
    artifact_id: "artifact-1",
    artifact_url:
      "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
    title: "费曼学习法",
  });
});

test("presentation artifact result keeps earlier progress ordering", () => {
  let message: ChatMessageItem = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    contentJson: {},
    parentMessageId: null,
    metadata: {},
    createdAt: new Date(0).toISOString(),
  };
  const streamToolCallsById = new Map<
    string,
    {
      id: string;
      tool: string;
      input: Record<string, unknown>;
      output: unknown;
      latencyMs: number | null;
      status: "running" | "approval_requested" | "completed" | "error";
      error: string | null;
    }
  >();
  const streamRenderBuffer = createStreamingRenderBuffer({
    maxDeltaBatchChars: 800,
  });
  let refreshCount = 0;
  streamRenderBuffer.appendText("Before presentation. ");
  let drainCount = 0;
  const context = createBaseStreamingContext({
    isCompletedArtifactToolCall: (toolCall, event) =>
      toolCall.tool === "publish_artifact" &&
      toolCall.status === "completed" &&
      event.type === "tool-call-result",
    resolveToolCallFromStreamEvent: ({ event }) => {
      const eventData = getToolEventData(event);
      return {
        id: event.id ?? "pptx-tool",
        tool: "publish_artifact",
        input: { title: "费曼学习法" },
        output:
          event.type === "tool-call-result"
            ? {
                artifact_id: "artifact-1",
                artifact_url:
                  "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
                title: "费曼学习法",
              }
            : event.type === "tool-call-event"
              ? eventData
              : null,
        latencyMs: event.type === "tool-call-result" ? 12 : null,
        status: event.type === "tool-call-result" ? "completed" : "running",
        error: null,
      };
    },
    streamRenderBuffer,
    streamToolCallsById,
    syncStreamingToolCalls: () => {
      message = {
        ...message,
        metadata: {
          ...message.metadata,
          renderBlocks: streamRenderBuffer.snapshotRenderBlocks(),
          toolCalls: [...streamToolCallsById.values()],
        },
      };
    },
    updateStreamingAssistantMessage: (updater) => {
      message = updater(message);
    },
  });
  const refreshedArtifactToolIds = new Set<string>();

  testExports.handleStreamingToolCallEvent({
    context,
    drainQueuedDeltasNow: () => {
      drainCount += 1;
    },
    event: {
      type: "tool-call-event",
      id: "pptx-tool",
      data: {
        type: "publish_artifact_progress",
        toolCallId: "pptx-tool",
        stage: "planning",
        title: "费曼学习法",
      },
    },
    refreshedArtifactToolIds,
    refreshedWorkfileToolIds: new Set(),
    setArtifactsRefreshKey: (updater) => {
      refreshCount = updater(refreshCount);
    },
    setWorkfilesRefreshKey: () => undefined,
  });
  testExports.handleStreamingToolCallEvent({
    context,
    drainQueuedDeltasNow: () => {
      drainCount += 1;
    },
    event: {
      type: "tool-call-start",
      id: "pptx-tool",
    },
    refreshedArtifactToolIds,
    refreshedWorkfileToolIds: new Set(),
    setArtifactsRefreshKey: (updater) => {
      refreshCount = updater(refreshCount);
    },
    setWorkfilesRefreshKey: () => undefined,
  });
  testExports.handleStreamingToolCallEvent({
    context,
    drainQueuedDeltasNow: () => undefined,
    event: {
      type: "tool-call-result",
      id: "pptx-tool",
    },
    refreshedArtifactToolIds,
    refreshedWorkfileToolIds: new Set(),
    setArtifactsRefreshKey: (updater) => {
      refreshCount = updater(refreshCount);
    },
    setWorkfilesRefreshKey: () => undefined,
  });

  // The progress tool card remains after the earlier assistant text. The tool
  // result itself does not infer or append an artifact output block.
  assert.equal(drainCount, 1);
  assert.equal(refreshCount, 1);
  assert.deepEqual(message.metadata.renderBlocks, [
    {
      id: "stream-text-1",
      type: "text",
      text: "Before presentation. ",
    },
    {
      id: "stream-tool-pptx-tool",
      type: "tool",
      toolCallId: "pptx-tool",
    },
  ]);
  assert.equal(streamToolCallsById.get("pptx-tool")?.status, "completed");
});

test("presentation artifact result without a published URL does not append card", () => {
  let message: ChatMessageItem = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    contentJson: {},
    parentMessageId: null,
    metadata: {},
    createdAt: new Date(0).toISOString(),
  };
  const streamToolCallsById = new Map<
    string,
    {
      id: string;
      tool: string;
      input: Record<string, unknown>;
      output: unknown;
      latencyMs: number | null;
      status: "running" | "approval_requested" | "completed" | "error";
      error: string | null;
    }
  >();
  const streamRenderBuffer = createStreamingRenderBuffer({
    maxDeltaBatchChars: 800,
  });
  let refreshCount = 0;
  const context = createBaseStreamingContext({
    isCompletedArtifactToolCall: (toolCall, event) =>
      toolCall.tool === "publish_artifact" &&
      toolCall.status === "completed" &&
      event.type === "tool-call-result" &&
      Boolean((toolCall.output as Record<string, unknown>).artifact_url),
    resolveToolCallFromStreamEvent: ({ event }) => ({
      id: event.id ?? "pptx-tool",
      tool: "publish_artifact",
      input: { title: "费曼学习法" },
      output:
        event.type === "tool-call-result"
          ? {
              status: "ready",
              title: "费曼学习法",
            }
          : null,
      latencyMs: event.type === "tool-call-result" ? 12 : null,
      status: event.type === "tool-call-result" ? "completed" : "running",
      error: null,
    }),
    streamRenderBuffer,
    streamToolCallsById,
    syncStreamingToolCalls: () => {
      message = {
        ...message,
        metadata: {
          ...message.metadata,
          renderBlocks: streamRenderBuffer.snapshotRenderBlocks(),
          toolCalls: [...streamToolCallsById.values()],
        },
      };
    },
    updateStreamingAssistantMessage: (updater) => {
      message = updater(message);
    },
  });

  testExports.handleStreamingToolCallEvent({
    context,
    drainQueuedDeltasNow: () => undefined,
    event: {
      type: "tool-call-result",
      id: "pptx-tool",
    },
    refreshedArtifactToolIds: new Set(),
    refreshedWorkfileToolIds: new Set(),
    setArtifactsRefreshKey: (updater) => {
      refreshCount = updater(refreshCount);
    },
    setWorkfilesRefreshKey: () => undefined,
  });

  assert.equal(refreshCount, 0);
  assert.deepEqual(message.metadata.renderBlocks, []);
});
