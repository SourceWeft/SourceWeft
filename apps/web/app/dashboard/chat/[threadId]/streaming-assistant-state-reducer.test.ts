import assert from "node:assert/strict";
import { test } from "vitest";
import { finishStreamingAssistantRun } from "./streaming-assistant-state-reducer";
import type {
  ThinkingStepRecord,
  ToolCallRecord,
} from "../_components/chat-canvas";

function runningToolCall(
  overrides: Partial<ToolCallRecord> = {},
): ToolCallRecord {
  return {
    id: "tool-1",
    tool: "web_search",
    input: {},
    output: null,
    latencyMs: null,
    status: "running",
    error: null,
    ...overrides,
  };
}

function runningStep(
  overrides: Partial<ThinkingStepRecord> = {},
): ThinkingStepRecord {
  return {
    id: "step-1",
    kind: "reasoning_summary",
    title: "Thinking",
    status: "in_progress",
    items: [],
    ...overrides,
  };
}

test("finishStreamingAssistantRun completes running tool calls and steps once", () => {
  const state = finishStreamingAssistantRun({
    durableRunKey: "sourceweft-web-run:run-1",
    existingRun: { status: "running" },
    existingStatus: "running",
    mode: "send",
    renderBlocks: [{ id: "text-1", text: "Done", type: "text" }],
    thinkingSteps: [runningStep()],
    toolCalls: [runningToolCall()],
  });

  assert.equal(state.status, "completed");
  assert.equal(state.metadata.finishReason, "stop");
  assert.equal(state.metadata.thinkingSteps[0]?.status, "completed");
  assert.equal(state.metadata.toolCalls[0]?.status, "completed");
  assert.deepEqual(state.metadata.renderBlocks, [
    { id: "text-1", text: "Done", type: "text" },
  ]);
});

test("finishStreamingAssistantRun preserves approval wait as explicit lifecycle", () => {
  const state = finishStreamingAssistantRun({
    durableRunKey: "sourceweft-web-run:run-1",
    existingRun: { status: "running" },
    existingStatus: "running",
    finishReason: "tool_confirmation_requested",
    mode: "send",
    renderBlocks: [],
    thinkingSteps: [runningStep()],
    toolCalls: [runningToolCall({ status: "approval_requested" })],
  });

  assert.equal(state.status, "waiting_for_approval");
  assert.equal(state.metadata.finishReason, "tool_confirmation_requested");
  assert.equal(state.metadata.threadRun.status, "waiting_for_approval");
  assert.equal(state.metadata.toolCalls[0]?.status, "approval_requested");
});

test("finishStreamingAssistantRun preserves existing terminal failure status", () => {
  const state = finishStreamingAssistantRun({
    durableRunKey: "sourceweft-web-run:run-1",
    existingRun: { status: "failed" },
    existingStatus: "failed",
    mode: "send",
    renderBlocks: [],
    thinkingSteps: [runningStep()],
    toolCalls: [runningToolCall()],
  });

  assert.equal(state.status, "failed");
  assert.equal(state.metadata.threadRun.status, "failed");
  assert.equal(state.metadata.toolCalls[0]?.status, "completed");
});
