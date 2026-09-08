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
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, type SubAgent } from "deepagents";
import { z } from "zod";
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
import { adaptToolsEvent } from "./v3-protocol";

const ECHO_MARKER = "ECHO_SUBAGENT_MARKER";

/** Main agent delegates via `task`; the delegate calls `echo`, then answers. */
class ScriptedModel extends BaseChatModel {
  private taskCounter = 0;
  private echoCounter = 0;
  constructor(params: BaseChatModelParams = {}) {
    super(params);
  }
  _llmType() {
    return "scripted";
  }
  getName() {
    return "ChatScripted";
  }
  bindTools() {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const last = messages.at(-1);
    if (last instanceof ToolMessage) {
      const message = new AIMessage({ content: "done" });
      return { generations: [{ text: "done", message }] };
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
      this.echoCounter += 1;
      const message = new AIMessage({
        content: "",
        tool_calls: [
          {
            id: `echo-${this.echoCounter}`,
            name: "echo",
            args: { text: "hi" },
          },
        ],
      });
      return { generations: [{ text: "", message }] };
    }
    this.taskCounter += 1;
    const message = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: `task-${this.taskCounter}`,
          name: "task",
          args: {
            description: "echo something back. Then stop.",
            subagent_type: "echoer",
          },
        },
      ],
    });
    return { generations: [{ text: "", message }] };
  }
}

/** Records every message list it is asked to complete, answers "ok". */
class RecordingModel extends BaseChatModel {
  readonly seen: BaseMessage[][] = [];
  constructor(params: BaseChatModelParams = {}) {
    super(params);
  }
  _llmType() {
    return "recording";
  }
  getName() {
    return "ChatRecording";
  }
  bindTools() {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push([...messages]);
    const message = new AIMessage({ content: "ok" });
    return { generations: [{ text: "ok", message }] };
  }
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
    model: new ScriptedModel() as never,
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
  const recording = new RecordingModel();
  const childAgent = createDeepAgent({
    model: recording as never,
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
