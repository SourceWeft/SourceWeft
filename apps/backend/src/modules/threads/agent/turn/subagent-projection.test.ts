import assert from "node:assert/strict";
import { test } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { DeepAgentTurnEvent } from "./events";
import type { PreparedThreadTurn, ToolCallTrace } from "../..";
import { createPreparedThreadTurn } from "../../../../test/prepared-turn";
import {
  attachChildThreadToTaskOutput,
  createSubagentProjector,
  deriveSubagentThreadTitle,
  readChildThreadIdFromTaskOutput,
  readTaskReport,
  SubagentTranscriptCollector,
  transcriptToMessages,
} from "./subagent-projection";

test("the child thread title is the brief's first sentence, capped", () => {
  assert.equal(
    deriveSubagentThreadTitle("验证等式 1+1=2。请用直接计算验证。", "Explore"),
    "验证等式 1+1=2。",
  );
  assert.equal(
    deriveSubagentThreadTitle("Verify 1+2=3. Use any tools.", "Explore"),
    "Verify 1+2=3.",
  );
  assert.equal(deriveSubagentThreadTitle("   \n\n  ", "Explore"), "Explore");
  const long = deriveSubagentThreadTitle("x".repeat(90), "Explore");
  assert.ok(long.endsWith("…"));
  assert.ok(long.length <= 61);
});

test("the task result carries the child thread id without losing its shape", () => {
  const command = { lg_name: "Command", update: { messages: [] } };
  const tagged = attachChildThreadToTaskOutput(command, "thread_child");
  assert.equal(readChildThreadIdFromTaskOutput(tagged), "thread_child");
  assert.deepEqual((tagged as { update: unknown }).update, command.update);
  assert.equal(readChildThreadIdFromTaskOutput(command), null);
  // A plain-string report is wrapped so the id can ride along.
  const wrapped = attachChildThreadToTaskOutput("done", "thread_child");
  assert.equal(readChildThreadIdFromTaskOutput(wrapped), "thread_child");
  assert.equal(readTaskReport(wrapped), "done");
  assert.equal(readChildThreadIdFromTaskOutput(null), null);
});

test("the report is read from the Command's last ToolMessage or a plain string", () => {
  assert.equal(readTaskReport("plain"), "plain");
  assert.equal(
    readTaskReport({
      update: {
        messages: [{ kwargs: { content: [{ type: "text", text: "report" }] } }],
      },
    }),
    "report",
  );
  assert.equal(readTaskReport({ update: { messages: [] } }), null);
});

function feedEchoRun(collector: SubagentTranscriptCollector) {
  collector.observeMessages({ event: "message-start" });
  collector.observeMessages({ event: "message-finish" });
  collector.observeTool({
    event: "on_tool_start",
    name: "echo",
    toolCallId: "echo-1",
    input: { text: "hi" },
  });
  collector.observeTool({
    event: "on_tool_end",
    name: "echo",
    toolCallId: "echo-1",
    output: "echoed: hi",
  });
  collector.observeMessages({ event: "message-start" });
  collector.observeMessages({
    event: "content-block-delta",
    delta: { type: "text-delta", text: "do" },
  });
  collector.observeMessages({
    event: "content-block-delta",
    delta: { type: "text-delta", text: "ne" },
  });
  collector.observeMessages({ event: "message-finish" });
}

test("the collector folds a delegate's events into an ordered transcript", () => {
  const collector = new SubagentTranscriptCollector();
  feedEchoRun(collector);
  assert.deepEqual(collector.entries, [
    {
      kind: "ai",
      text: "",
      toolCalls: [{ id: "echo-1", name: "echo", args: { text: "hi" } }],
    },
    {
      kind: "tool",
      id: "echo-1",
      name: "echo",
      content: "echoed: hi",
      status: "completed",
    },
    { kind: "ai", text: "done", toolCalls: [] },
  ]);
  const messages = transcriptToMessages({
    brief: "echo something back",
    entries: collector.entries,
    report: "done",
  });
  assert.equal(messages.length, 4);
  assert.ok(messages[0] instanceof HumanMessage);
  assert.ok(messages[1] instanceof AIMessage);
  assert.deepEqual(
    (messages[1] as AIMessage).tool_calls?.map((call) => call.id),
    ["echo-1"],
  );
  assert.ok(messages[2] instanceof ToolMessage);
  assert.equal((messages[2] as ToolMessage).tool_call_id, "echo-1");
  assert.equal(messages[3]?.content, "done");
});

test("parallel tool calls attach to the same assistant turn even when results interleave", () => {
  const collector = new SubagentTranscriptCollector();
  collector.observeMessages({ event: "message-start" });
  collector.observeMessages({ event: "message-finish" });
  collector.observeTool({
    event: "on_tool_start",
    name: "a",
    toolCallId: "a-1",
    input: {},
  });
  collector.observeTool({
    event: "on_tool_end",
    name: "a",
    toolCallId: "a-1",
    output: { content: "ra" },
  });
  collector.observeTool({
    event: "on_tool_start",
    name: "b",
    toolCallId: "b-1",
    input: {},
  });
  collector.observeTool({
    event: "on_tool_error",
    name: "b",
    toolCallId: "b-1",
    error: "boom",
  });
  const [first] = collector.entries;
  assert.equal(first?.kind, "ai");
  assert.deepEqual(
    first?.kind === "ai" ? first.toolCalls.map((call) => call.id) : [],
    ["a-1", "b-1"],
  );
  assert.equal(collector.entries.length, 3);
  assert.deepEqual(collector.entries[2], {
    kind: "tool",
    id: "b-1",
    name: "b",
    content: "boom",
    status: "error",
  });
});

test("a dangling tool call gets a synthesized result and a missing answer gets the report", () => {
  const messages = transcriptToMessages({
    brief: "brief",
    entries: [
      {
        kind: "ai",
        text: "",
        toolCalls: [{ id: "x", name: "search", args: {} }],
      },
    ],
    report: "final report",
  });
  assert.equal(messages.length, 4);
  assert.ok(messages[2] instanceof ToolMessage);
  assert.match(String(messages[2]?.content), /No result was recorded/);
  assert.equal(messages[3]?.content, "final report");
  // No assistant turns at all: brief + report.
  const bare = transcriptToMessages({
    brief: "brief",
    entries: [],
    report: "r",
  });
  assert.equal(bare.length, 2);
  assert.equal(bare[1]?.content, "r");
});

function createPrepared(): PreparedThreadTurn {
  return createPreparedThreadTurn({
    userId: "user_1",
    modelAlias: "chat-default",
    workspace: { id: "workspace_1", organizationId: "team_1" },
    thread: {
      id: "thread_parent",
      teamId: "team_1",
      workspaceId: "workspace_1",
      visibility: "workspace",
      parentThreadId: null,
      modelSettings: {},
    },
  });
}

test("the projector opens a child thread per task and persists its transcript once", async () => {
  const created: unknown[] = [];
  const persisted: unknown[] = [];
  const traces = new Map<string, ToolCallTrace>([
    [
      "echo-1",
      {
        id: "echo-1",
        tool: "echo",
        input: { text: "hi" },
        output: { content: "echoed: hi" },
        status: "completed",
        latencyMs: 5,
        error: null,
        sequence: 3,
      },
    ],
  ]);
  const projector = createSubagentProjector({
    prepared: createPrepared(),
    toolTraces: traces,
    seedCheckpoint: async () => null,
    findChildThread: async () => null,
    createChildThread: async (input) => {
      created.push(input);
      return { id: "thread_child", parentThreadId: "thread_parent" } as never;
    },
    persist: async (input) => {
      persisted.push(input);
      return { checkpoint: null, assistantRows: 1 };
    },
  });

  projector.startTask({
    taskCallId: "task-1",
    namespace: ["tools:branch-a"],
    input: {
      description: "echo something back. Then stop.",
      subagent_type: "explore",
    },
  });
  // Delegate events arrive at depth 2 under the task's namespace.
  projector.observeMessages(["tools:branch-a", "model_request:m1"], {
    event: "message-start",
  });
  projector.observeMessages(["tools:branch-a", "model_request:m1"], {
    event: "message-finish",
  });
  projector.observeTool(["tools:branch-a", "tools:t1"], {
    event: "on_tool_start",
    name: "echo",
    toolCallId: "echo-1",
    input: { text: "hi" },
  });
  projector.observeTool(["tools:branch-a", "tools:t1"], {
    event: "on_tool_end",
    name: "echo",
    toolCallId: "echo-1",
    output: "echoed: hi",
  });
  // A delegate's own delegate (depth 3) and an unrelated namespace are ignored.
  projector.observeMessages(
    ["tools:branch-a", "tools:t2", "model_request:m9"],
    {
      event: "message-start",
    },
  );
  projector.observeMessages(["tools:other", "model_request:m3"], {
    event: "message-start",
  });

  assert.equal(
    await projector.finishTask({ taskCallId: "task-1", report: "done" }),
    "thread_child",
  );
  assert.equal(
    await projector.finishTask({ taskCallId: "task-1", report: "done" }),
    null,
  );
  assert.equal(
    await projector.finishTask({ taskCallId: "unknown", report: null }),
    null,
  );
  await projector.flush();

  assert.equal(created.length, 1);
  assert.deepEqual(created[0], {
    parent: createPrepared().thread,
    userId: "user_1",
    subagentType: "explore",
    brief: "echo something back. Then stop.",
  });
  assert.equal(persisted.length, 1);
  const call = persisted[0] as Parameters<
    NonNullable<Parameters<typeof createSubagentProjector>[0]["persist"]>
  >[0];
  assert.equal(call.childThreadId, "thread_child");
  assert.equal(call.report, "done");
  assert.equal(call.subagentType, "explore");
  assert.equal(call.toolTraces.get("echo-1")?.latencyMs, 5);
  assert.deepEqual(
    call.entries.map((entry) => entry.kind),
    ["ai", "tool"],
  );
});

test("a failed child thread creation leaves the parent turn untouched", async () => {
  const projector = createSubagentProjector({
    prepared: createPrepared(),
    toolTraces: new Map(),
    seedCheckpoint: async () => null,
    findChildThread: async () => null,
    createChildThread: async () => {
      throw new Error("db down");
    },
    persist: async () => {
      throw new Error("must not be called");
    },
  });
  projector.startTask({
    taskCallId: "task-1",
    namespace: ["tools:b"],
    input: {},
  });
  assert.equal(
    await projector.finishTask({ taskCallId: "task-1", report: null }),
    null,
  );
  await projector.flush();
});

test("projection never adds a client event kind", async () => {
  // Compile-time guard: every kind the runner may emit is listed here. Adding
  // a new member to DeepAgentTurnEvent without updating this table fails
  // typecheck, which is the point — projection is persistence, not streaming.
  const KNOWN_EVENT_KINDS: Record<DeepAgentTurnEvent["type"], true> = {
    "text-delta": true,
    "text-replace": true,
    "text-interrupted": true,
    "tool-call-start": true,
    "tool-input-delta": true,
    "tool-call-event": true,
    "tool-call-result": true,
    "tool-call-error": true,
    "tool-call-end": true,
    "thinking-step": true,
    citations: true,
    reasoning: true,
    done: true,
  };
  assert.equal(Object.keys(KNOWN_EVENT_KINDS).length, 13);

  const projector = createSubagentProjector({
    prepared: createPrepared(),
    toolTraces: new Map(),
    seedCheckpoint: async () => null,
    findChildThread: async () => null,
    createChildThread: async () => ({ id: "c", parentThreadId: "p" }) as never,
    persist: async () => ({ checkpoint: null, assistantRows: 0 }),
  });
  const results: unknown[] = [
    projector.startTask({ taskCallId: "t", namespace: ["tools:x"], input: {} }),
    projector.observeMessages(["tools:x", "model_request:m"], {
      event: "message-start",
    }),
    projector.observeTool(["tools:x", "tools:y"], {
      event: "on_tool_start",
      name: "n",
      toolCallId: "c1",
    }),
    await projector.finishTask({ taskCallId: "t", report: null }),
  ];
  for (const result of results) {
    assert.equal(
      result !== null &&
        typeof result === "object" &&
        Symbol.asyncIterator in result,
      false,
    );
  }
  await projector.flush();
});

function createPausableProjector(options: {
  existing?: { id: string; parentThreadId: string } | null;
}) {
  const created: unknown[] = [];
  const found: unknown[] = [];
  const briefs: unknown[] = [];
  const persisted: Array<
    Parameters<
      NonNullable<Parameters<typeof createSubagentProjector>[0]["persist"]>
    >[0]
  > = [];
  const projector = createSubagentProjector({
    prepared: createPrepared(),
    toolTraces: new Map(),
    seedCheckpoint: async () => null,
    findChildThread: async (input) => {
      found.push(input);
      return (options.existing ?? null) as never;
    },
    createChildThread: async (input) => {
      created.push(input);
      return { id: "thread_child", parentThreadId: "thread_parent" } as never;
    },
    persistBrief: async (input) => {
      briefs.push(input);
    },
    persist: async (input) => {
      persisted.push(input);
      return { checkpoint: null, assistantRows: 1 };
    },
  });
  return { projector, created, found, briefs, persisted };
}

const PAUSED_TASK_INPUT = {
  description: "Send the weekly email.",
  subagent_type: "general-purpose",
};

test("a paused task writes only its brief and resumes in the same child thread within the run", async () => {
  const { projector, created, briefs, persisted } = createPausableProjector({});

  projector.startTask({
    taskCallId: "task-1",
    namespace: ["tools:branch-a"],
    input: PAUSED_TASK_INPUT,
  });
  projector.observeMessages(["tools:branch-a", "model_request:m1"], {
    event: "message-start",
  });
  projector.pauseTask("task-1");
  projector.pauseTask("task-1");
  await projector.flush();

  assert.equal(briefs.length, 1);
  assert.equal(persisted.length, 0);
  assert.deepEqual(briefs[0], {
    scope: { teamId: "team_1", workspaceId: "workspace_1" },
    childThreadId: "thread_child",
    parentThreadId: "thread_parent",
    taskCallId: "task-1",
    subagentType: "general-purpose",
    brief: "Send the weekly email.",
    createdBy: "user_1",
  });

  // An auto-approved decision resumes the same call in this run: the delegate
  // replays from its brief under a new branch namespace.
  projector.startTask({
    taskCallId: "task-1",
    namespace: ["tools:branch-b"],
    input: PAUSED_TASK_INPUT,
  });
  projector.observeMessages(["tools:branch-b", "model_request:m2"], {
    event: "message-start",
  });
  assert.equal(
    await projector.finishTask({ taskCallId: "task-1", report: "sent" }),
    "thread_child",
  );
  await projector.flush();

  assert.equal(created.length, 1);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.childThreadId, "thread_child");
  assert.equal(persisted[0]?.briefPersisted, true);
  // Only the replayed run is in the transcript.
  assert.deepEqual(
    persisted[0]?.entries.map((entry) => entry.kind),
    ["ai"],
  );
});

test("a task resumed in a later run continues the child thread its paused run opened", async () => {
  const { projector, created, found, briefs, persisted } =
    createPausableProjector({
      existing: { id: "thread_paused_child", parentThreadId: "thread_parent" },
    });

  projector.startTask({
    taskCallId: "task-1",
    namespace: ["tools:branch-a"],
    input: PAUSED_TASK_INPUT,
  });
  assert.equal(
    await projector.finishTask({ taskCallId: "task-1", report: "sent" }),
    "thread_paused_child",
  );
  await projector.flush();

  assert.deepEqual(found, [
    {
      teamId: "team_1",
      workspaceId: "workspace_1",
      parentThreadId: "thread_parent",
      taskCallId: "task-1",
    },
  ]);
  assert.equal(created.length, 0);
  assert.equal(briefs.length, 0);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.childThreadId, "thread_paused_child");
  assert.equal(persisted[0]?.briefPersisted, true);
});
