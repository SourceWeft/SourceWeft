/**
 * End-to-end validation of the load-bearing assumption behind sub-agent tool
 * grouping: that in the v3 event stream the runner reads, a `task` delegate's
 * tool events arrive with a namespace whose depth marks the sub-agent, while
 * the main agent's events do not — and that `isSubagentNamespace` reads the
 * real shape correctly.
 *
 * This drives a REAL `createDeepAgent` graph (deepagents composes the actual
 * `task` tool + sub-agent subgraph) with a scripted model, and inspects the raw
 * stream events — no mocking of the namespace.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, type SubAgent } from "deepagents";
import { z } from "zod";
import { ScriptedChatModel } from "../../../../test/chat-model";
import {
  isSubagentNamespace,
  recordToolCallNamespace,
  resolveToolProducer,
} from "./subagent-namespace";
import { adaptToolsEvent } from "./v3-protocol";
import type { ToolCallTrace } from "../..";

const ECHO_MARKER = "ECHO_SUBAGENT_MARKER";

/**
 * Scripted model. Behaviour is driven purely by the message history so the same
 * instance serves both the main agent and the sub-agent graph:
 * - last message is a tool result → stop (return plain text);
 * - the sub-agent's system prompt (carrying ECHO_MARKER) is present → call `echo`;
 * - otherwise (main agent, first turn) → delegate via `task`.
 */
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
            description: "echo something back",
            subagent_type: "echoer",
          },
        },
      ],
    });
  });
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

test("the v3 stream tags a delegate's tool events with a sub-agent namespace", async () => {
  const model = scriptedModel();
  const agent = createDeepAgent({
    model: model as never,
    tools: [],
    checkpointer: new MemorySaver(),
    subagents: [buildEchoSubagent()],
  } as never);

  // The stream the runner reads: `streamEvents` v3, whose namespaces keep the
  // `subgraphs: true` scheme. (The plain `stream` API changed its `tools`
  // namespaces in @langchain/langgraph 1.6; v3 did not.)
  const stream = (await (
    agent as never as {
      streamEvents: (
        input: unknown,
        config: unknown,
      ) => Promise<AsyncIterable<unknown>>;
    }
  ).streamEvents(
    { messages: [new HumanMessage("please echo")] },
    {
      configurable: { thread_id: "subgraph_e2e" },
      version: "v3",
      recursionLimit: 25,
    },
  )) as AsyncIterable<{
    method?: string;
    params?: { namespace?: unknown; data?: unknown };
  }>;

  const toolChunks: { namespace: unknown; payload: Record<string, unknown> }[] =
    [];
  const toolNameByCallId = new Map<string, string>();
  for await (const event of stream) {
    if (event?.method !== "tools") {
      continue;
    }
    const payload = adaptToolsEvent(event.params?.data, toolNameByCallId);
    if (payload?.event === "on_tool_start") {
      toolChunks.push({
        namespace: Array.isArray(event.params?.namespace)
          ? event.params?.namespace
          : [],
        payload: payload as unknown as Record<string, unknown>,
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
