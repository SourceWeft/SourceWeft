import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildTerminalAssistantTraceState,
  terminalizeToolCall,
} from "./assistant-run-terminal-state";
import type { ThinkingStepTrace, ToolCallTrace } from "./types";

function runningToolCall(
  overrides: Partial<ToolCallTrace> = {},
): ToolCallTrace {
  return {
    id: "tool-1",
    tool: "web_search",
    input: {},
    output: null,
    status: "running",
    latencyMs: null,
    error: null,
    sequence: 0,
    ...overrides,
  };
}

function runningStep(
  overrides: Partial<ThinkingStepTrace> = {},
): ThinkingStepTrace {
  return {
    id: "step-1",
    kind: "reasoning_summary",
    title: "Thinking",
    status: "in_progress",
    items: [],
    sequence: 0,
    ...overrides,
  };
}

test("terminalizeToolCall completes running tools on success", () => {
  assert.equal(
    terminalizeToolCall({ mode: "success", toolCall: runningToolCall() })
      .status,
    "completed",
  );
});

test("terminalizeToolCall marks running tools as error on failure", () => {
  const toolCall = terminalizeToolCall({
    mode: "error",
    toolCall: runningToolCall(),
  });

  assert.equal(toolCall.status, "error");
  assert.equal(toolCall.error, "Tool execution failed.");
});

test("terminal assistant state preserves a supplied cancellation reason", () => {
  const toolCall = terminalizeToolCall({
    errorMessage: "Chat run was cancelled",
    mode: "error",
    toolCall: runningToolCall(),
  });
  const state = buildTerminalAssistantTraceState({
    errorMessage: "Chat run was cancelled",
    mode: "error",
    traceParts: [
      {
        id: "tool-1",
        kind: "tool",
        order: 0,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        toolCallId: "tool-1",
        tool: "web_search",
        status: "running",
        input: {},
      },
    ],
  });

  assert.equal(toolCall.error, "Chat run was cancelled");
  assert.equal(
    state.traceParts.find((part) => part.kind === "tool")?.error,
    "Chat run was cancelled",
  );
});

test("buildTerminalAssistantTraceState closes active steps and trace parts", () => {
  const state = buildTerminalAssistantTraceState({
    mode: "success",
    runtimeThinkingSteps: [runningStep()],
    traceParts: [
      {
        id: "tool-1",
        kind: "tool",
        order: 0,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        toolCallId: "tool-1",
        tool: "web_search",
        status: "running",
        input: {},
      },
    ],
  });

  assert.equal(state.thinkingSteps[0]?.status, "completed");
  assert.equal(
    state.traceParts.find((part) => part.kind === "step")?.status,
    "completed",
  );
  assert.equal(
    state.traceParts.find((part) => part.kind === "tool")?.status,
    "completed",
  );
});
