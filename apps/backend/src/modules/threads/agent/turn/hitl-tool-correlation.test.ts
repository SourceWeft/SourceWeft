import assert from "node:assert/strict";
import { test } from "vitest";
import {
  applyToolsStreamToolEnd,
  rememberObservedToolCalls,
  resolveToolsStreamToolCall,
  type ObservedAgentToolCall,
} from "./tool-tracker";
import type { ToolCallTrace } from "../..";

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

test("resolveToolsStreamToolCall keeps run id starts pending until a real tool call id arrives", () => {
  const toolCallsById = new Map<string, ToolCallTrace>();
  const toolCallOrder: string[] = [];
  const pendingToolStreamsByRunId = new Map();
  const resolveToolCallSequence = () => 1;

  const start = resolveToolsStreamToolCall({
    pendingToolStreamsByRunId,
    payload: {
      event: "on_tool_start",
      runId: "run-write",
      name: "write_file",
      input: { path: "a.txt" },
    },
    resolveToolCallSequence,
    toolCallOrder,
    toolCallsById,
  });
  assert.equal(start, null);
  assert.equal(toolCallOrder.length, 0);
  assert.equal(toolCallsById.size, 0);
  assert.deepEqual(
    pendingToolStreamsByRunId.get("run-write")?.normalizedInput,
    {
      path: "a.txt",
    },
  );

  const end = resolveToolsStreamToolCall({
    pendingToolStreamsByRunId,
    payload: {
      event: "on_tool_end",
      runId: "run-write",
      toolCallId: "call_write",
      name: "write_file",
      input: { path: "a.txt", content: "A" },
      output: "ok",
    },
    resolveToolCallSequence,
    toolCallOrder,
    toolCallsById,
  });

  assert.equal(end?.toolCallId, "call_write");
  assert.equal(typeof end?.pendingStartedAt, "number");
  assert.deepEqual(end?.normalizedInput, { path: "a.txt", content: "A" });
  assert.deepEqual(toolCallOrder, ["call_write"]);
  assert.equal(pendingToolStreamsByRunId.size, 0);
});

test("resolveToolsStreamToolCall ignores generic id and does not create a tool call id", () => {
  const toolCallsById = new Map<string, ToolCallTrace>();
  const toolCallOrder: string[] = [];

  const event = resolveToolsStreamToolCall({
    payload: {
      event: "on_tool_start",
      id: "generic-event-id",
      name: "write_file",
      input: { path: "a.txt" },
    },
    resolveToolCallSequence: () => 1,
    toolCallOrder,
    toolCallsById,
  });

  assert.equal(event, null);
  assert.equal(toolCallsById.size, 0);
  assert.deepEqual(toolCallOrder, []);
});

test("resolveToolsStreamToolCall does not promote run id without a real tool call id", () => {
  const toolCallsById = new Map<string, ToolCallTrace>();
  const toolCallOrder: string[] = [];
  const pendingToolStreamsByRunId = new Map();

  const event = resolveToolsStreamToolCall({
    pendingToolStreamsByRunId,
    payload: {
      event: "on_tool_end",
      run_id: "run-write",
      name: "write_file",
      output: "ok",
    },
    resolveToolCallSequence: () => 1,
    toolCallOrder,
    toolCallsById,
  });

  assert.equal(event, null);
  assert.equal(toolCallsById.size, 0);
  assert.deepEqual(toolCallOrder, []);
  assert.equal(pendingToolStreamsByRunId.has("run-write"), true);
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
