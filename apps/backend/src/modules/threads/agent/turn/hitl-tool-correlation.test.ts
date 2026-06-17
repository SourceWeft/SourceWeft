import assert from "node:assert/strict";
import { test } from "vitest";
import { matchInterruptedToolCall } from "./hitl-handler";
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

test("matchInterruptedToolCall requires a unique exact name and args match", () => {
  const match = matchInterruptedToolCall({
    action: { name: "write_file", args: { path: "b.txt" } },
    index: 0,
    toolCalls: [
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
        toolCalls: [
          { id: "call_a", name: "write_file", args: { path: "a.txt" } },
          { id: "call_b", name: "write_file", args: { path: "a.txt" } },
        ],
        usedToolCallIds: new Set(),
      }),
    /current checkpoint included multiple identical tool calls/,
  );
});

test("matchInterruptedToolCall binds duplicate args by action index when available", () => {
  const match = matchInterruptedToolCall({
    action: { name: "execute", args: { command: "npm test" } },
    index: 1,
    toolCalls: [
      {
        id: "call_execute_1",
        index: 0,
        name: "execute",
        args: { command: "npm test" },
      },
      {
        id: "call_execute_2",
        index: 1,
        name: "execute",
        args: { command: "npm test" },
      },
    ],
    usedToolCallIds: new Set(),
  });

  assert.equal(match.id, "call_execute_2");
});

test("matchInterruptedToolCall only uses current interrupt candidates", () => {
  const match = matchInterruptedToolCall({
    action: { name: "execute", args: { command: "npm test" } },
    index: 0,
    toolCalls: [
      { id: "call_new", name: "execute", args: { command: "npm test" } },
    ],
    usedToolCallIds: new Set(),
  });

  assert.equal(match.id, "call_new");
});

test("matchInterruptedToolCall dedupes repeated current candidates by tool call id", () => {
  const match = matchInterruptedToolCall({
    action: { name: "execute", args: { command: "npm test" } },
    index: 0,
    toolCalls: [
      { id: "call_execute", name: "execute", args: { command: "npm test" } },
      { id: "call_execute", name: "execute", args: { command: "npm test" } },
    ],
    usedToolCallIds: new Set(),
  });

  assert.equal(match.id, "call_execute");
});

test("matchInterruptedToolCall does not fall back to historical args when current candidate mismatches", () => {
  assert.throws(
    () =>
      matchInterruptedToolCall({
        action: { name: "execute", args: { command: "npm test" } },
        index: 0,
        toolCalls: [
          {
            id: "call_new",
            name: "execute",
            args: { command: "npm run build" },
          },
        ],
        usedToolCallIds: new Set(),
      }),
    /current checkpoint did not include one exact matching tool call/,
  );
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

test("sandbox tool aliases merge replayed results onto the approved canonical tool call", () => {
  const canonicalToolCall: ToolCallTrace = {
    ...runningToolCall("call-approved-execute", { command: "npm test" }),
    approvalState: "approved",
    approvalConfirmationId: "confirmation-1",
  };
  const toolCallsById = new Map<string, ToolCallTrace>([
    [canonicalToolCall.id, canonicalToolCall],
  ]);
  const toolCallOrder = [canonicalToolCall.id];
  const snapshot = resolveToolsStreamToolCall({
    toolCallAliasesById: new Map([
      ["call-replayed-execute", "call-approved-execute"],
    ]),
    payload: {
      event: "on_tool_end",
      name: "execute",
      toolCallId: "call-replayed-execute",
      input: { command: "npm test" },
      output: { exitCode: 0 },
    },
    resolveToolCallSequence: () => 99,
    toolCallOrder,
    toolCallsById,
  });

  assert.equal(snapshot?.toolCallId, "call-approved-execute");
  assert.deepEqual(toolCallOrder, ["call-approved-execute"]);

  const next = applyToolsStreamToolEnd({
    currentToolCall: snapshot!.currentToolCall,
    error: null,
    latencyMs: 10,
    normalizedInput: snapshot!.normalizedInput,
    output: { exitCode: 0 },
    toolCallId: snapshot!.toolCallId,
    toolCallsById,
    toolName: snapshot!.toolName,
    toolStatus: "completed",
  });

  assert.deepEqual(next, {
    id: "call-approved-execute",
    tool: "execute",
    input: { command: "npm test" },
    output: { exitCode: 0 },
    status: "completed",
    latencyMs: 10,
    error: null,
    sequence: 1,
    approvalState: "approved",
    approvalConfirmationId: "confirmation-1",
  });
  assert.equal(toolCallsById.has("call-replayed-execute"), false);
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
