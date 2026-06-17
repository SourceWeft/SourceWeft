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
