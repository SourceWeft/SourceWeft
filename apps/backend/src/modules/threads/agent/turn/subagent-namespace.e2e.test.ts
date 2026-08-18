/**
 * End-to-end validation of the load-bearing assumption behind sub-agent tool
 * grouping: that under LangGraph `subgraphs: true`, a `task` delegate's tool
 * events arrive with a namespace whose segment marks the sub-agent, while the
 * main agent's events do not — and that `classifyStreamNamespace` reads the real
 * shape correctly.
 *
 * This drives a REAL `createDeepAgent` graph (deepagents composes the actual
 * `task` tool + sub-agent subgraph) with a scripted model, and inspects the raw
 * stream chunks — no mocking of the namespace.
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
import { createDeepAgent, StateBackend, type SubAgent } from "deepagents";
import { z } from "zod";
import {
  isSubagentNamespace,
  recordToolCallNamespace,
  resolveToolProducer,
} from "./subagent-namespace";
import type { ToolCallTrace } from "../..";

const ECHO_MARKER = "ECHO_SUBAGENT_MARKER";

/**
 * Scripted model. Behaviour is driven purely by the message history so the same
 * instance serves both the main agent and the sub-agent graph:
 * - last message is a tool result → stop (return plain text);
 * - the sub-agent's system prompt (carrying ECHO_MARKER) is present → call `echo`;
 * - otherwise (main agent, first turn) → delegate via `task`.
 */
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
            description: "echo something back",
            subagent_type: "echoer",
          },
        },
      ],
    });
    return { generations: [{ text: "", message }] };
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

test("subgraphs:true tags a delegate's tool events with a sub-agent namespace", async () => {
  const model = new ScriptedModel();
  const agent = createDeepAgent({
    model: model as never,
    tools: [],
    checkpointer: new MemorySaver(),
    subagents: [buildEchoSubagent()],
  } as never);

  const stream = (await (
    agent as never as {
      stream: (input: unknown, config: unknown) => Promise<AsyncIterable<unknown>>;
    }
  ).stream(
    { messages: [new HumanMessage("please echo")] },
    {
      configurable: { thread_id: "subgraph_e2e" },
      streamMode: ["messages", "tools", "updates"],
      subgraphs: true,
      recursionLimit: 25,
    },
  )) as AsyncIterable<unknown>;

  const toolChunks: { namespace: unknown; payload: Record<string, unknown> }[] =
    [];
  let sawThreeTuple = false;
  for await (const chunk of stream) {
    if (!Array.isArray(chunk) || chunk.length < 2) {
      continue;
    }
    const hasNamespace = Array.isArray(chunk[0]);
    if (hasNamespace) {
      sawThreeTuple = true;
    }
    const namespace = hasNamespace ? chunk[0] : [];
    const mode = hasNamespace ? chunk[1] : chunk[0];
    const payload = hasNamespace ? chunk[2] : chunk[1];
    if (
      mode === "tools" &&
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload)
    ) {
      toolChunks.push({
        namespace,
        payload: payload as Record<string, unknown>,
      });
    }
  }

  // Surface the real shape for the record.
  console.log(
    "[subgraph-e2e] tool chunk namespaces:",
    JSON.stringify(
      toolChunks.map((chunk) => ({
        name: chunk.payload.name,
        namespace: chunk.namespace,
      })),
    ),
  );

  assert.ok(sawThreeTuple, "expected [namespace, mode, payload] chunks");

  const echoChunk = toolChunks.find((chunk) => chunk.payload.name === "echo");
  assert.ok(echoChunk, "expected an `echo` tool event from the sub-agent");
  assert.equal(
    isSubagentNamespace(echoChunk.namespace),
    true,
    `echo namespace should classify as sub-agent; got ${JSON.stringify(
      echoChunk.namespace,
    )}`,
  );

  // The parent `task` tool call is depth-1 and must NOT be mistaken for a
  // sub-agent (the failure mode a naive "has a tools: segment" rule would hit).
  const taskChunk = toolChunks.find((chunk) => chunk.payload.name === "task");
  assert.ok(taskChunk, "expected the main agent's `task` tool event");
  assert.equal(
    isSubagentNamespace(taskChunk.namespace),
    false,
    `task namespace should classify as main; got ${JSON.stringify(
      taskChunk.namespace,
    )}`,
  );

  // Replay the runner's correlation: record the task event's namespace, then the
  // child resolves its delegate name from the parent task call by prefix.
  const taskCallId =
    typeof taskChunk.payload.toolCallId === "string"
      ? taskChunk.payload.toolCallId
      : typeof taskChunk.payload.tool_call_id === "string"
        ? (taskChunk.payload.tool_call_id as string)
        : "task-call";
  const toolCallsById = new Map<string, ToolCallTrace>([
    [
      taskCallId,
      {
        id: taskCallId,
        tool: "task",
        input: { subagent_type: "echoer" },
        output: null,
        status: "running",
        latencyMs: null,
        error: null,
        sequence: 0,
      },
    ],
  ]);
  const taskCallIdByNamespaceKey = new Map<string, string>();
  recordToolCallNamespace(
    taskChunk.namespace,
    taskCallId,
    taskCallIdByNamespaceKey,
  );
  assert.deepEqual(
    resolveToolProducer(echoChunk.namespace, {
      toolCallsById,
      taskCallIdByNamespaceKey,
    }),
    { kind: "subagent", taskCallId, subagentType: "echoer" },
  );
}, 30_000);
