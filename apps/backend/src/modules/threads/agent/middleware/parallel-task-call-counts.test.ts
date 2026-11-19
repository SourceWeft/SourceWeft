import assert from "node:assert/strict";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { StateBackend, createDeepAgent } from "deepagents";
import { tool, toolCallLimitMiddleware } from "langchain";
import { test } from "vitest";
import { z } from "zod/v4";
import { ScriptedChatModel } from "../../../../test/chat-model";

// langchain's toolCallLimitMiddleware keeps its counts in last-value channels,
// and a parent and its delegates each carry the middleware. Up to deepagents
// 1.13.3 a delegate returned those counts to the parent, so two `task` calls in
// one model step wrote the parent's channel twice and the turn failed with
// "LastValue can only receive one value per step". Since 1.13.4 deepagents
// keeps call counts on each side of the subagent boundary. This runs the
// installed SDK with no channel override, so it fails if that ever regresses.
test("parallel task delegates leave the parent's tool-call counters alone", async () => {
  const probe = tool(async () => "ok", {
    name: "probe",
    description: "probe",
    schema: z.object({}),
  });
  const limits = () =>
    toolCallLimitMiddleware({
      threadLimit: 50,
      runLimit: 50,
      exitBehavior: "continue",
    });

  let parentCalls = 0;
  const parent = new ScriptedChatModel(() =>
    parentCalls++ === 0
      ? new AIMessage({
          content: "",
          tool_calls: ["task-a", "task-b"].map((id) => ({
            id,
            name: "task",
            args: { description: `work for ${id}`, subagent_type: "worker" },
          })),
        })
      : new AIMessage("parent done"),
  );
  let childCalls = 0;
  const child = new ScriptedChatModel((messages) =>
    messages.some((message) => ToolMessage.isInstance(message))
      ? new AIMessage("child done")
      : new AIMessage({
          content: "",
          tool_calls: [
            { id: `probe-${childCalls++}`, name: "probe", args: {} },
          ],
        }),
  );

  const agent = createDeepAgent({
    model: parent as never,
    tools: [probe],
    backend: new StateBackend(),
    checkpointer: new MemorySaver(),
    middleware: [limits()],
    subagents: [
      {
        name: "worker",
        description: "does the work",
        systemPrompt: "Do the work.",
        model: child as never,
        tools: [probe],
        middleware: [limits()],
      },
    ],
  });

  const result = (await agent.invoke(
    { messages: [new HumanMessage("delegate twice")] },
    { configurable: { thread_id: "parallel-task-call-counts" } },
  )) as { messages: BaseMessage[]; threadToolCallCount?: unknown };

  const taskResults = result.messages.filter(
    (message) => ToolMessage.isInstance(message) && message.name === "task",
  );
  assert.equal(taskResults.length, 2);
  assert.ok(taskResults.every((message) => message.content === "child done"));
  // Both delegates ran their own tool call, and the parent counted only its own.
  assert.equal(childCalls, 2);
  assert.deepEqual(result.threadToolCallCount, { __all__: 2 });
});
