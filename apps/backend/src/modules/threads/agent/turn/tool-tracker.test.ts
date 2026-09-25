import assert from "node:assert/strict";
import { test } from "vitest";
import type { ToolCallTrace } from "../..";
import {
  applyToolsStreamToolStart,
  buildDeepAgentTodosStep,
  createTraceSequenceAllocator,
  parseDeepAgentTodos,
  resolveDeepAgentTodosStepStatus,
  resolveToolsStreamToolCall,
} from "./tool-tracker";

test("sub-agent producer is stamped on the tool trace and preserved across events", () => {
  const toolCallsById = new Map<string, ToolCallTrace>();
  const toolCallOrder: string[] = [];
  const producer = {
    kind: "subagent" as const,
    taskCallId: "task-1",
    subagentType: "explore",
  };

  const snapshot = resolveToolsStreamToolCall({
    payload: {
      event: "on_tool_start",
      name: "grep",
      toolCallId: "child-1",
      input: { pattern: "foo" },
    },
    producer,
    resolveToolCallSequence: () => 1,
    toolCallOrder,
    toolCallsById,
  });
  assert.ok(snapshot);
  assert.deepEqual(toolCallsById.get("child-1")?.producer, producer);

  // The apply* helpers spread the current trace, so the producer must survive a
  // subsequent lifecycle event.
  const next = applyToolsStreamToolStart({
    currentToolCall: snapshot.currentToolCall,
    normalizedInput: { pattern: "foo" },
    toolCallId: "child-1",
    toolCallsById,
    toolName: "grep",
  });
  assert.deepEqual(next.producer, producer);
});

test("main-agent tool calls carry no producer tag", () => {
  const toolCallsById = new Map<string, ToolCallTrace>();
  resolveToolsStreamToolCall({
    payload: {
      event: "on_tool_start",
      name: "read_file",
      toolCallId: "main-1",
      input: {},
    },
    resolveToolCallSequence: () => 1,
    toolCallOrder: [],
    toolCallsById,
  });
  assert.equal(toolCallsById.get("main-1")?.producer, undefined);
});

test("parses DeepAgents write_todos input into display-safe todos", () => {
  assert.deepEqual(
    parseDeepAgentTodos({
      todos: [
        { content: "Inspect current runner", status: "completed" },
        { content: "Surface todos in trace", status: "in_progress" },
        { content: "Run tests", status: "pending" },
        { content: "Skip invalid status", status: "blocked" },
        { content: "   ", status: "pending" },
      ],
    }),
    [
      { content: "Inspect current runner", status: "completed" },
      { content: "Surface todos in trace", status: "in_progress" },
      { content: "Run tests", status: "pending" },
    ],
  );
});

test("builds a stable DeepAgents todo thinking step", () => {
  const todos = [
    { content: "Inspect current runner", status: "completed" as const },
    { content: "Surface todos in trace", status: "in_progress" as const },
    { content: "Run tests", status: "pending" as const },
  ];

  assert.deepEqual(
    buildDeepAgentTodosStep({
      toolCallId: "call-todos",
      todos,
    }),
    {
      id: "deepagents:todos",
      kind: "state",
      title: "Task plan",
      status: "in_progress",
      items: [
        "Completed: Inspect current runner",
        "In progress: Surface todos in trace",
        "Pending: Run tests",
      ],
      metadata: {
        display: "todo_list",
        source: "deepagents",
        tool: "write_todos",
        toolCallId: "call-todos",
        todos,
        visibility: "user",
      },
    },
  );
});

test("derives DeepAgents todo step status from todo states", () => {
  assert.equal(
    resolveDeepAgentTodosStepStatus([{ content: "Plan", status: "pending" }]),
    "pending",
  );
  assert.equal(
    resolveDeepAgentTodosStepStatus([
      { content: "Plan", status: "completed" },
      { content: "Implement", status: "completed" },
    ]),
    "completed",
  );
  assert.equal(
    resolveDeepAgentTodosStepStatus([
      { content: "Plan", status: "completed" },
      { content: "Implement", status: "in_progress" },
    ]),
    "in_progress",
  );
});

test("trace continuation keeps approval tool sequence and advances new events", () => {
  const allocator = createTraceSequenceAllocator({
    traceContinuation: {
      maxSequence: 4,
      toolSequenceById: {
        "approval-tool": 4,
      },
    },
  });

  assert.equal(allocator.resolveToolCallSequence("approval-tool"), 4);
  assert.equal(allocator.nextSequence(), 5);
  assert.equal(allocator.resolveToolCallSequence("new-tool"), 6);
  assert.equal(allocator.resolveToolCallSequence("new-tool"), 6);
  assert.equal(allocator.nextSequence(), 7);
});
