import assert from "node:assert/strict";
import { test } from "vitest";
import type { AssistantRenderSegment } from "./assistant-render-segments";
import {
  getAttachedWebToolCallIds,
  shouldRenderWebToolResultsFallback,
} from "../web-tool-results-state";
import { findLastAnswerSegmentId } from "./message-evidence";
import {
  shouldShowAssistantBottomLoading,
  shouldShowAssistantLiveThinking,
} from "./message-list-state";
import type { ToolCallRecord } from "./types";

function webToolCall(id: string): ToolCallRecord {
  return {
    error: null,
    id,
    input: {},
    latencyMs: 1000,
    output: {
      pages: [
        {
          citation: "c1",
          title: "Example",
          url: "https://example.com",
        },
      ],
    },
    status: "completed",
    tool: "web_search",
  };
}

test("findLastAnswerSegmentId returns the last non-empty answer segment", () => {
  const segments: AssistantRenderSegment[] = [
    {
      blocks: [{ id: "b1", text: "Earlier answer", type: "text" }],
      id: "answer-1",
      type: "answer",
    },
    {
      blocks: [{ id: "w1", text: "work", type: "reasoning" }],
      id: "workflow-2",
      type: "workflow",
    },
    {
      blocks: [{ id: "b2", text: "", type: "text" }],
      id: "answer-3",
      type: "answer",
    },
    {
      blocks: [{ id: "b3", text: "Final answer", type: "text" }],
      id: "answer-4",
      type: "answer",
    },
  ];

  assert.equal(findLastAnswerSegmentId({ segments }), "answer-4");
});

test("getAttachedWebToolCallIds includes rendered web tool blocks", () => {
  const toolCalls = [webToolCall("web-1"), webToolCall("web-2")];

  assert.deepEqual(
    Array.from(
      getAttachedWebToolCallIds({
        renderBlocks: [
          { id: "block-web-1", toolCallId: "web-1", type: "tool" },
        ],
        toolCalls,
      }),
    ).sort(),
    ["web-1"],
  );
});

test("shouldRenderWebToolResultsFallback detects web results without an activity row", () => {
  const toolCalls = [webToolCall("web-1"), webToolCall("web-2")];

  assert.equal(
    shouldRenderWebToolResultsFallback({
      attachedToolCallIds: ["web-1"],
      toolCalls,
    }),
    true,
  );

  assert.equal(
    shouldRenderWebToolResultsFallback({
      attachedToolCallIds: ["web-1", "web-2"],
      toolCalls,
    }),
    false,
  );
});

test("shouldShowAssistantLiveThinking only shows during uncancelled streams", () => {
  assert.equal(shouldShowAssistantLiveThinking({ isStreaming: true }), true);
  assert.equal(
    shouldShowAssistantLiveThinking({ isCancelled: true, isStreaming: true }),
    false,
  );
  assert.equal(shouldShowAssistantLiveThinking({ isStreaming: false }), false);
});

test("shouldShowAssistantBottomLoading shows while streaming even before answer text", () => {
  assert.equal(shouldShowAssistantBottomLoading({ isStreaming: true }), true);
});

test("shouldShowAssistantBottomLoading stays visible while answer text streams", () => {
  assert.equal(shouldShowAssistantBottomLoading({ isStreaming: true }), true);
});

test("shouldShowAssistantBottomLoading hides for inactive assistant states", () => {
  const base = {
    isStreaming: true,
  };

  assert.equal(
    shouldShowAssistantBottomLoading({
      ...base,
      isTextPaused: true,
    }),
    false,
  );
  assert.equal(
    shouldShowAssistantBottomLoading({
      ...base,
      threadRunStatus: "waiting_for_approval",
    }),
    false,
  );
  assert.equal(
    shouldShowAssistantBottomLoading({
      ...base,
      isCancelled: true,
    }),
    false,
  );
  assert.equal(
    shouldShowAssistantBottomLoading({
      ...base,
      isStreaming: false,
    }),
    false,
  );
});
