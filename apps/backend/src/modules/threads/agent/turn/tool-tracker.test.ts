import assert from "node:assert/strict";
import { test } from "vitest";
import { PUBLISHED_ARTIFACT_NEXT_STEP } from "@sourceweft/contracts/agent-tools";
import type { ThinkingStepTrace, ToolCallTrace } from "../..";
import {
  applyToolsStreamToolStart,
  buildDeepAgentTodosStep,
  closeDeepAgentTodosAfterCommittedDelivery,
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

const plannedTodos = [
  { content: "Draft the report", status: "completed" as const },
  { content: "Publish and summarize", status: "in_progress" as const },
  { content: "Optional appendix", status: "pending" as const },
];
const todoStep = (toolCallId = "call-todos"): ThinkingStepTrace => ({
  ...buildDeepAgentTodosStep({ toolCallId, todos: plannedTodos }),
  sequence: 1,
});
const traced = (
  id: string,
  tool: string,
  output: unknown,
  extra: Partial<ToolCallTrace> = {},
): ToolCallTrace => ({
  id,
  tool,
  input: {},
  output,
  status: "completed",
  error: null,
  latencyMs: 1,
  sequence: 1,
  ...extra,
});
const publishReceipt = JSON.stringify({
  ok: true,
  type: "html_artifact_result",
  status: "ready",
  nextStep: PUBLISHED_ARTIFACT_NEXT_STEP,
  artifactType: "html",
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
});
const writeTodos = traced("call-todos", "write_todos", "Updated todo list");

test("host closes the in-progress todo after a committed publish", () => {
  const closed = closeDeepAgentTodosAfterCommittedDelivery({
    step: todoStep(),
    toolCalls: [
      writeTodos,
      traced("call-publish", "publish_artifact", publishReceipt),
    ],
  });
  assert.deepEqual(closed, {
    id: "deepagents:todos",
    kind: "state",
    title: "Task plan",
    status: "pending",
    items: [
      "Completed: Draft the report",
      "Completed: Publish and summarize",
      "Pending: Optional appendix",
    ],
    metadata: {
      display: "todo_list",
      source: "deepagents",
      tool: "write_todos",
      toolCallId: "call-todos",
      todos: [
        { content: "Draft the report", status: "completed" },
        { content: "Publish and summarize", status: "completed" },
        { content: "Optional appendix", status: "pending" },
      ],
      visibility: "user",
      closedBy: "committed_delivery",
    },
  });
  // A ToolMessage-shaped output proves the same receipt.
  assert.equal(
    closeDeepAgentTodosAfterCommittedDelivery({
      step: todoStep(),
      toolCalls: [
        writeTodos,
        traced("call-publish", "publish_artifact", {
          lc: 1,
          type: "constructor",
          kwargs: { content: publishReceipt, tool_call_id: "call-publish" },
        }),
      ],
    })?.status,
    "pending",
  );
});

test("todos stay as written without a committed receipt after the write", () => {
  const close = (toolCalls: ToolCallTrace[], step = todoStep()) =>
    closeDeepAgentTodosAfterCommittedDelivery({ step, toolCalls });
  const publish = traced("call-publish", "publish_artifact", publishReceipt);
  // No publish at all, or only a failed one.
  assert.equal(close([writeTodos]), null);
  assert.equal(
    close([
      writeTodos,
      traced(
        "call-publish",
        "publish_artifact",
        JSON.stringify({ ok: false, status: "failed" }),
      ),
    ]),
    null,
  );
  assert.equal(
    close([writeTodos, { ...publish, status: "error", error: "denied" }]),
    null,
  );
  // A receipt-shaped output from a tool without a terminal result contract.
  assert.equal(
    close([writeTodos, traced("call-read", "read_file", publishReceipt)]),
    null,
  );
  // The list was written after the publish: it is the model's own later state.
  assert.equal(close([publish, writeTodos]), null);
  // The write is not part of this run's trace.
  assert.equal(close([publish], todoStep("call-earlier-run")), null);
  // Nothing in progress, or no todo step.
  assert.equal(
    close([writeTodos, publish], {
      ...buildDeepAgentTodosStep({
        toolCallId: "call-todos",
        todos: [{ content: "Publish", status: "completed" }],
      }),
      sequence: 1,
    }),
    null,
  );
  assert.equal(
    closeDeepAgentTodosAfterCommittedDelivery({
      step: undefined,
      toolCalls: [writeTodos, publish],
    }),
    null,
  );
});

test("only a receipt from the scope that wrote the todo list closes it", () => {
  const subagent = {
    producer: {
      kind: "subagent" as const,
      subagentType: "writer",
      taskCallId: "call-task",
    },
  };
  const close = (toolCalls: ToolCallTrace[]) =>
    closeDeepAgentTodosAfterCommittedDelivery({ step: todoStep(), toolCalls });
  assert.equal(
    close([
      writeTodos,
      traced("call-publish", "publish_artifact", publishReceipt, subagent),
    ]),
    null,
  );
  assert.equal(
    close([
      { ...writeTodos, ...subagent },
      traced("call-publish", "publish_artifact", publishReceipt),
    ]),
    null,
  );
  assert.equal(
    close([
      { ...writeTodos, ...subagent },
      traced("call-publish", "publish_artifact", publishReceipt, subagent),
    ])?.metadata?.closedBy,
    "committed_delivery",
  );
});
