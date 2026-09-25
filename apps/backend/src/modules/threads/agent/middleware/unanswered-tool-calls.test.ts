import assert from "node:assert/strict";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { Command, MemorySaver } from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import { test } from "vitest";
import { z } from "zod";
import { ScriptedChatModel } from "../../../../test/chat-model";
import {
  answerUnansweredToolCalls,
  createSourceWeftUnansweredToolCallsMiddleware,
  UNANSWERED_TOOL_CALL_RESULT,
} from "./unanswered-tool-calls";

const call = (id: string, subject: string) => ({
  id,
  name: "send",
  args: { subject },
  type: "tool_call" as const,
});

function unansweredCallIds(messages: readonly BaseMessage[]) {
  const answered = new Set(
    messages.filter(ToolMessage.isInstance).map((m) => m.tool_call_id),
  );
  return messages
    .filter(AIMessage.isInstance)
    .flatMap((m) => m.tool_calls ?? [])
    .map((c) => c.id)
    .filter((id) => id && !answered.has(id));
}

test("an unanswered tool call gets a not-run result after the existing ones", () => {
  const ai = new AIMessage({
    content: "",
    tool_calls: [call("b", "B"), call("a", "A")],
  });
  const rejected = new ToolMessage({ tool_call_id: "b", content: "rejected" });
  const messages = [new HumanMessage("send both"), ai, rejected];

  const result = answerUnansweredToolCalls(messages);

  assert.equal(result.length, 4);
  assert.equal(result[1], ai);
  assert.equal(result[2], rejected);
  const added = result[3] as ToolMessage;
  assert.ok(ToolMessage.isInstance(added));
  assert.equal(added.tool_call_id, "a");
  assert.equal(added.content, UNANSWERED_TOOL_CALL_RESULT);
  assert.equal(added.status, "error");
});

test("a call the message's content still names is restored and answered", () => {
  // What HITL leaves behind: `tool_calls` trimmed to the rejected call while
  // the content blocks still hold the model's full batch.
  const trimmed = new AIMessage({
    id: "ai-1",
    content: [
      { type: "tool_call", id: "a", name: "send", args: { subject: "A" } },
      { type: "tool_call", id: "b", name: "send", args: { subject: "B" } },
    ] as never,
    tool_calls: [call("a", "A"), call("b", "B")],
  });
  trimmed.tool_calls = [call("b", "B")];
  const rejected = new ToolMessage({ tool_call_id: "b", content: "rejected" });

  const result = answerUnansweredToolCalls([
    new HumanMessage("send both"),
    trimmed,
    rejected,
  ]);

  const restored = result[1] as AIMessage;
  assert.equal(restored.id, "ai-1");
  // Restored in the model's own order, with the results following it.
  assert.deepEqual(
    restored.tool_calls?.map((c) => c.id),
    ["a", "b"],
  );
  assert.deepEqual(
    result.slice(2).map((m) => (m as ToolMessage).tool_call_id),
    ["a", "b"],
  );
});

test("a fully answered history is returned as is", () => {
  const messages = [
    new HumanMessage("send"),
    new AIMessage({ content: "", tool_calls: [call("a", "A")] }),
    new ToolMessage({ tool_call_id: "a", content: "sent" }),
    new AIMessage("done"),
  ];
  assert.equal(answerUnansweredToolCalls(messages), messages);
});

async function runMixedDecisionTurn(extraMiddleware: boolean) {
  const seen: BaseMessage[][] = [];
  const model = new ScriptedChatModel((messages) => {
    seen.push([...messages]);
    if (seen.length > 1) {
      return "done";
    }
    // As the chat model returns it under v1 output: the calls also live in the
    // content blocks.
    return new AIMessage({
      response_metadata: { output_version: "v1" },
      content: [
        { type: "reasoning", reasoning: "send both" },
        { type: "tool_call", id: "a", name: "send", args: { subject: "A" } },
        { type: "tool_call", id: "b", name: "send", args: { subject: "B" } },
      ] as never,
      tool_calls: [call("a", "A"), call("b", "B")],
    });
  });
  const send = tool(async ({ subject }) => `sent ${subject}`, {
    name: "send",
    description: "Send an email.",
    schema: z.object({ subject: z.string() }),
  });
  const agent = createAgent({
    model,
    tools: [send],
    checkpointer: new MemorySaver(),
    middleware: [
      humanInTheLoopMiddleware({ interruptOn: { send: true } }),
      ...(extraMiddleware
        ? [createSourceWeftUnansweredToolCallsMiddleware()]
        : []),
    ],
  });
  const config = { configurable: { thread_id: "mixed" } };
  await agent.invoke({ messages: [new HumanMessage("send A and B")] }, config);
  await agent.invoke(
    new Command({
      resume: {
        decisions: [
          { type: "approve" },
          { type: "reject", message: "Do not send B." },
        ],
      },
    }),
    config,
  );
  return seen;
}

test("approve + reject in one batch drops the approved call from the model's message without the middleware", async () => {
  // LangChain's HITL keeps only the rejected call and jumps to the model, so
  // the next request carries a message the model never produced — which a
  // provider validating its own output (DeepSeek thinking mode) rejects.
  const seen = await runMixedDecisionTurn(false);
  assert.equal(seen.length, 2);
  const message = seen[1]!.find(AIMessage.isInstance)!;
  assert.deepEqual(
    message.tool_calls?.map((c) => c.id),
    ["b"],
  );
});

test("with the middleware, the next model call keeps the model's message and answers every call", async () => {
  const seen = await runMixedDecisionTurn(true);
  assert.equal(seen.length, 2);
  const next = seen[1]!;
  const message = next.find(AIMessage.isInstance)!;
  assert.deepEqual(message.tool_calls?.map((c) => c.id).sort(), ["a", "b"]);
  assert.deepEqual(unansweredCallIds(next), []);
  const results = next.filter(ToolMessage.isInstance);
  assert.deepEqual(
    results.map((m) => [m.tool_call_id, String(m.content)]),
    [
      ["a", UNANSWERED_TOOL_CALL_RESULT],
      ["b", "Do not send B."],
    ],
  );
});
