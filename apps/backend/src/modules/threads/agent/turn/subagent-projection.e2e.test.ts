/**
 * End-to-end check of the projection against a REAL `createDeepAgent` graph:
 * the delegate's v3 events are folded into a transcript exactly the way the
 * runner feeds them, the transcript is seeded into the child thread's
 * checkpoint through the parent graph, and a second, differently-built graph
 * (standing in for the persona thread's own agent) continues on that thread
 * and sees the delegate's history before the new user message.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { isGraphBubbleUp, MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, type SubAgent } from "deepagents";
import { createMiddleware } from "langchain";
import { z } from "zod";
import { ScriptedChatModel } from "../../../../test/chat-model";
import type { PreparedThreadTurn } from "../..";
import { isSubagentNamespace } from "./subagent-namespace";
import {
  attachChildThreadToTaskOutput,
  createSubagentProjector,
  readChildThreadIdFromTaskOutput,
  readTaskReport,
  seedChildCheckpointWith,
  TASK_TOOL_NAME,
  transcriptToMessages,
} from "./subagent-projection";
import {
  adaptToolsEvent,
  adoptV3RunStream,
  interruptsToLegacyUpdatesPayload,
} from "./v3-protocol";

const ECHO_MARKER = "ECHO_SUBAGENT_MARKER";

/** Main agent delegates via `task`; the delegate calls `echo`, then answers. */
function scriptedModel() {
  let taskCounter = 0;
  let echoCounter = 0;
  return new ScriptedChatModel((messages) => {
    const last = messages.at(-1);
    if (last instanceof ToolMessage) {
      return "done";
    }
    const inSubagent = messages.some((message) => {
      const content = message.content;
      if (typeof content === "string") {
        return content.includes(ECHO_MARKER);
      }
      return (
        Array.isArray(content) &&
        content.some(
          (block) =>
            typeof (block as { text?: unknown }).text === "string" &&
            (block as { text: string }).text.includes(ECHO_MARKER),
        )
      );
    });
    if (inSubagent) {
      echoCounter += 1;
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: `echo-${echoCounter}`,
            name: "echo",
            args: { text: "hi" },
          },
        ],
      });
    }
    taskCounter += 1;
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          id: `task-${taskCounter}`,
          name: "task",
          args: {
            description: "echo something back. Then stop.",
            subagent_type: "echoer",
          },
        },
      ],
    });
  });
}

/** Records every message list it is asked to complete, answers "ok". */
function recordingModel() {
  const seen: BaseMessage[][] = [];
  const model = new ScriptedChatModel(
    (messages) => {
      seen.push([...messages]);
      return "ok";
    },
    { name: "recording" },
  );
  return { model, seen };
}

const echoTool = tool(async ({ text }: { text: string }) => `echoed: ${text}`, {
  name: "echo",
  description: "Echo the given text back.",
  schema: z.object({ text: z.string() }),
});

function buildEchoSubagent(): SubAgent {
  return {
    name: "echoer",
    description: "A trivial delegate that echoes text.",
    systemPrompt: `You are a delegate. ${ECHO_MARKER}. Call echo, then stop.`,
    tools: [echoTool] as unknown as SubAgent["tools"],
    interruptOn: {},
  };
}

type V3Event = {
  method?: string;
  params?: { namespace?: unknown; data?: unknown };
};

test("a task delegate's run is projected into a child thread the persona can continue", async () => {
  const saver = new MemorySaver();
  const parentAgent = createDeepAgent({
    model: scriptedModel() as never,
    tools: [],
    checkpointer: saver,
    subagents: [buildEchoSubagent()],
  } as never);

  const prepared = {
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
  } as unknown as PreparedThreadTurn;

  let persistedEntries: unknown[] = [];
  let persistedReport: string | null = null;
  let seededCheckpoint: unknown = null;
  const projector = createSubagentProjector({
    prepared,
    toolTraces: new Map(),
    seedCheckpoint: seedChildCheckpointWith(parentAgent),
    // A fresh task has no persisted child; keep this graph test database-free.
    findChildThread: async () => null,
    createChildThread: async () =>
      ({ id: "thread_child", parentThreadId: "thread_parent" }) as never,
    // Persist without a database: seed the checkpoint exactly as the real
    // persistence does, and keep the transcript for assertions.
    persist: async (input) => {
      persistedEntries = [...input.entries];
      persistedReport = input.report;
      seededCheckpoint = await input.seedCheckpoint({
        childThreadId: input.childThreadId,
        messages: transcriptToMessages({
          brief: input.brief,
          entries: input.entries,
          report: input.report,
        }),
      });
      return { checkpoint: null, assistantRows: 0 };
    },
  });

  // Drive the parent exactly as the runner does.
  const run = (await (
    parentAgent as never as {
      streamEvents: (
        input: unknown,
        config: unknown,
      ) => Promise<AsyncIterable<V3Event>>;
    }
  ).streamEvents(
    { messages: [new HumanMessage("please echo")] },
    {
      configurable: { thread_id: "thread_parent" },
      version: "v3",
      recursionLimit: 25,
    },
  )) as AsyncIterable<V3Event>;
  const toolNameByCallId = new Map<string, string>();
  let taggedTaskOutput: unknown = null;
  let childThreadIdFromFinish: string | null = null;
  for await (const event of run) {
    const method = event?.method;
    if (typeof method !== "string") continue;
    const namespace = Array.isArray(event.params?.namespace)
      ? event.params?.namespace
      : [];
    const data = event.params?.data;
    const subagentEvent = isSubagentNamespace(namespace);
    if (subagentEvent && method !== "tools") {
      if (method === "messages") {
        projector.observeMessages(namespace, data);
      }
      continue;
    }
    if (method !== "tools") continue;
    const payload = adaptToolsEvent(data, toolNameByCallId);
    if (!payload) continue;
    if (subagentEvent) {
      projector.observeTool(namespace, payload);
      continue;
    }
    if (payload.name !== TASK_TOOL_NAME) continue;
    const taskCallId = String(payload.toolCallId);
    if (payload.event === "on_tool_start") {
      projector.startTask({ taskCallId, namespace, input: payload.input });
    } else if (payload.event === "on_tool_end") {
      childThreadIdFromFinish = await projector.finishTask({
        taskCallId,
        report: readTaskReport(payload.output),
      });
      if (childThreadIdFromFinish) {
        taggedTaskOutput = attachChildThreadToTaskOutput(
          payload.output,
          childThreadIdFromFinish,
        );
      }
    }
  }
  await projector.flush();

  assert.equal(childThreadIdFromFinish, "thread_child");
  assert.equal(
    readChildThreadIdFromTaskOutput(taggedTaskOutput),
    "thread_child",
  );
  assert.equal(readTaskReport(taggedTaskOutput), "done");
  assert.equal(persistedReport, "done");
  assert.deepEqual(
    (persistedEntries as Array<{ kind: string }>).map((entry) => entry.kind),
    ["ai", "tool", "ai"],
  );
  const lastTurn = persistedEntries[2] as { text: string };
  assert.equal(lastTurn.text, "done");
  assert.equal(
    (seededCheckpoint as { threadId?: string } | null)?.threadId,
    "thread_child",
  );

  // The child thread's own agent (a different graph on the same checkpointer,
  // as the persona thread's turn builds) continues from the projected history.
  const recording = recordingModel();
  const childAgent = createDeepAgent({
    model: recording.model as never,
    tools: [],
    checkpointer: saver,
  } as never);
  await (
    childAgent as never as {
      invoke: (input: unknown, config: unknown) => Promise<unknown>;
    }
  ).invoke(
    { messages: [new HumanMessage("and now?")] },
    { configurable: { thread_id: "thread_child" }, recursionLimit: 10 },
  );
  const seen = recording.seen[0] ?? [];
  const history = seen
    .filter((message) => message.getType() !== "system")
    .map((message) => `${message.getType()}:${String(message.content)}`);
  assert.deepEqual(history, [
    "human:echo something back. Then stop.",
    "ai:",
    "tool:echoed: hi",
    "ai:done",
    "human:and now?",
  ]);
}, 30_000);

test("a delegate paused for approval surfaces one interrupt and a paused, not failed, task", async () => {
  const parentAgent = createDeepAgent({
    model: scriptedModel() as never,
    tools: [],
    checkpointer: new MemorySaver(),
    subagents: [{ ...buildEchoSubagent(), interruptOn: { echo: true } }],
  } as never);

  const run = adoptV3RunStream(
    await (
      parentAgent as never as {
        streamEvents: (input: unknown, config: unknown) => Promise<unknown>;
      }
    ).streamEvents(
      { messages: [new HumanMessage("please echo")] },
      {
        configurable: { thread_id: "thread_parent" },
        version: "v3",
        recursionLimit: 25,
      },
    ),
  );
  const toolNameByCallId = new Map<string, string>();
  const taskEvents: Array<Record<string, unknown>> = [];
  for await (const event of run as AsyncIterable<V3Event>) {
    if (event?.method !== "tools") continue;
    const namespace = Array.isArray(event.params?.namespace)
      ? event.params?.namespace
      : [];
    if (isSubagentNamespace(namespace)) continue;
    const payload = adaptToolsEvent(event.params?.data, toolNameByCallId);
    if (payload?.name === TASK_TOOL_NAME) taskEvents.push(payload);
  }

  // The delegate's interrupt is reported by its subgraph and again as it
  // bubbles through the parent; collapsed, it is one approval.
  assert.equal(run.interrupted, true);
  const ids = run.interrupts.map((entry) => entry.interruptId);
  assert.ok(ids.length >= 2, `expected a repeated interrupt, got ${ids}`);
  assert.equal(new Set(ids).size, 1);
  assert.equal(
    interruptsToLegacyUpdatesPayload(run.interrupts).__interrupt__.length,
    1,
  );

  // The parent's `task` call started and reports nothing more: since
  // @langchain/langgraph 1.6 a paused tool is not a tool error. The runner
  // therefore marks open `task` calls paused when the run ends interrupted
  // (`pauseOpenTasks`).
  assert.deepEqual(
    taskEvents.map((payload) => payload.event),
    ["on_tool_start"],
  );
}, 30_000);

test("a task call the tool rejects opens no child thread; the retried call opens one", async () => {
  // The model names a sub-agent type that does not exist, the `task` tool
  // refuses before any delegate runs, and the model calls again with a valid
  // type. As in the thread agent, a tool error goes back to the model.
  let taskCalls = 0;
  const model = new ScriptedChatModel((messages) => {
    const last = messages.at(-1);
    const inSubagent = messages.some(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes(ECHO_MARKER),
    );
    if (inSubagent) {
      return last instanceof ToolMessage
        ? "done"
        : new AIMessage({
            content: "",
            tool_calls: [{ id: "echo-1", name: "echo", args: { text: "hi" } }],
          });
    }
    if (taskCalls >= 2) {
      return "done";
    }
    taskCalls += 1;
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          id: `task-${taskCalls}`,
          name: "task",
          args: {
            description: "echo something back. Then stop.",
            subagent_type: taskCalls === 1 ? "false" : "echoer",
          },
        },
      ],
    });
  });
  const returnToolErrors = createMiddleware({
    name: "ReturnToolErrors",
    wrapToolCall: async (request, handler) => {
      try {
        return await handler(request);
      } catch (error) {
        if (isGraphBubbleUp(error)) throw error;
        return new ToolMessage({
          content: String(error),
          tool_call_id: request.toolCall.id ?? "",
          status: "error",
        });
      }
    },
  });
  const parentAgent = createDeepAgent({
    model: model as never,
    tools: [],
    checkpointer: new MemorySaver(),
    subagents: [buildEchoSubagent()],
    middleware: [returnToolErrors],
  } as never);

  const created: unknown[] = [];
  const persisted: string[] = [];
  const projector = createSubagentProjector({
    prepared: {
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
    } as unknown as PreparedThreadTurn,
    toolTraces: new Map(),
    seedCheckpoint: async () => null,
    findChildThread: async () => null,
    createChildThread: async (input) => {
      created.push(input);
      return { id: "thread_child", parentThreadId: "thread_parent" } as never;
    },
    persist: async (input) => {
      persisted.push(input.taskCallId);
      return { checkpoint: null, assistantRows: 0 };
    },
  });

  const run = (await (
    parentAgent as never as {
      streamEvents: (input: unknown, config: unknown) => Promise<unknown>;
    }
  ).streamEvents(
    { messages: [new HumanMessage("please echo")] },
    {
      configurable: { thread_id: "thread_parent" },
      version: "v3",
      recursionLimit: 25,
    },
  )) as AsyncIterable<V3Event>;
  const toolNameByCallId = new Map<string, string>();
  const taskEvents: string[] = [];
  const finished: Array<string | null> = [];
  for await (const event of run) {
    const method = event?.method;
    if (typeof method !== "string") continue;
    const namespace = Array.isArray(event.params?.namespace)
      ? event.params?.namespace
      : [];
    const data = event.params?.data;
    const subagentEvent = isSubagentNamespace(namespace);
    if (subagentEvent && method !== "tools") {
      if (method === "messages") {
        projector.observeMessages(namespace, data);
      }
      continue;
    }
    if (method !== "tools") continue;
    const payload = adaptToolsEvent(data, toolNameByCallId);
    if (!payload) continue;
    if (subagentEvent) {
      projector.observeTool(namespace, payload);
      continue;
    }
    if (payload.name !== TASK_TOOL_NAME) continue;
    const taskCallId = String(payload.toolCallId);
    taskEvents.push(`${taskCallId}:${payload.event}`);
    if (payload.event === "on_tool_start") {
      projector.startTask({ taskCallId, namespace, input: payload.input });
    } else if (
      payload.event === "on_tool_end" ||
      payload.event === "on_tool_error"
    ) {
      const ended = payload.event === "on_tool_end";
      finished.push(
        await projector.finishTask({
          taskCallId,
          report: ended ? readTaskReport(payload.output) : null,
          failed: !ended,
        }),
      );
    }
  }
  await projector.flush();

  assert.deepEqual(taskEvents, [
    "task-1:on_tool_start",
    "task-1:on_tool_error",
    "task-2:on_tool_start",
    "task-2:on_tool_end",
  ]);
  assert.deepEqual(finished, [null, "thread_child"]);
  assert.equal(created.length, 1);
  assert.equal(
    (created[0] as { subagentType?: string }).subagentType,
    "echoer",
  );
  assert.deepEqual(persisted, ["task-2"]);
}, 30_000);
