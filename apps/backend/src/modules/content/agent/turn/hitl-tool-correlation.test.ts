import assert from "node:assert/strict";
import { test } from "vitest";
import { matchInterruptedToolCall } from "./hitl-handler";
import {
  applyToolsStreamToolEnd,
  rememberObservedToolCalls,
  resolveToolsStreamToolCall,
  type ObservedAgentToolCall,
} from "./tool-tracker";
import type { ToolCallTrace } from "../../threads";

test("rememberObservedToolCalls updates partial args for the same tool call id", () => {
  const observed = new Map<string, ObservedAgentToolCall>();

  rememberObservedToolCalls(observed, [
    { id: "call_1", name: "write_file", args: {} },
  ]);
  rememberObservedToolCalls(observed, [
    { id: "call_1", name: "write_file", args: { path: "a.txt", content: "A" } },
  ]);

  assert.deepEqual(observed.get("call_1")?.args, {
    path: "a.txt",
    content: "A",
  });
});

test("matchInterruptedToolCall requires a unique exact name and args match", () => {
  const match = matchInterruptedToolCall({
    action: { name: "write_file", args: { path: "b.txt" } },
    index: 0,
    observedToolCalls: [
      { id: "call_a", name: "write_file", args: { path: "a.txt" } },
      { id: "call_b", name: "write_file", args: { path: "b.txt" } },
    ],
    usedToolCallIds: new Set(),
  });

  assert.equal(match.id, "call_b");
});

test("matchInterruptedToolCall fails closed for ambiguous identical args", () => {
  assert.throws(
    () =>
      matchInterruptedToolCall({
        action: { name: "write_file", args: { path: "a.txt" } },
        index: 0,
        observedToolCalls: [
          { id: "call_a", name: "write_file", args: { path: "a.txt" } },
          { id: "call_b", name: "write_file", args: { path: "a.txt" } },
        ],
        usedToolCallIds: new Set(),
      }),
    /multiple streamed tool calls had identical arguments/,
  );
});

test("resolveToolsStreamToolCall correlates non-start events to one running same-name call", () => {
  const toolCallsById = new Map<string, ToolCallTrace>();
  const toolCallOrder: string[] = [];
  const resolveToolCallSequence = () => 1;

  const start = resolveToolsStreamToolCall({
    payload: {
      event: "on_tool_start",
      name: "write_file",
      input: { path: "a.txt" },
    },
    resolveToolCallSequence,
    toolCallOrder,
    toolCallsById,
  });
  assert.ok(start);

  const end = resolveToolsStreamToolCall({
    payload: {
      event: "on_tool_end",
      name: "write_file",
      input: { path: "a.txt", content: "A" },
      output: "ok",
    },
    resolveToolCallSequence,
    toolCallOrder,
    toolCallsById,
  });

  assert.equal(end?.toolCallId, start.toolCallId);
});

test("resolveToolsStreamToolCall does not guess when same-name running calls are ambiguous", () => {
  const toolCallsById = new Map<string, ToolCallTrace>([
    ["call_a", runningToolCall("call_a")],
    ["call_b", runningToolCall("call_b")],
  ]);

  const event = resolveToolsStreamToolCall({
    payload: { event: "on_tool_end", name: "write_file", output: "ok" },
    resolveToolCallSequence: () => 1,
    toolCallOrder: ["call_a", "call_b"],
    toolCallsById,
  });

  assert.equal(event, null);
});

test("applyToolsStreamToolEnd keeps the more complete end input", () => {
  const toolCallsById = new Map<string, ToolCallTrace>();
  const currentToolCall = runningToolCall("call_a", { path: "a.txt" });

  const next = applyToolsStreamToolEnd({
    currentToolCall,
    error: null,
    latencyMs: 10,
    normalizedInput: { path: "a.txt", content: "A" },
    output: "ok",
    toolCallId: "call_a",
    toolCallsById,
    toolName: "write_file",
    toolStatus: "completed",
  });

  assert.deepEqual(next.input, { path: "a.txt", content: "A" });
});

function runningToolCall(
  id: string,
  input: Record<string, unknown> = {},
): ToolCallTrace {
  return {
    id,
    tool: "write_file",
    input,
    output: null,
    status: "running",
    latencyMs: null,
    error: null,
    sequence: 1,
  };
}
