import assert from "node:assert/strict";
import { ToolMessage } from "@langchain/core/messages";
import { GraphInterrupt, MemorySaver } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents";
import { tool } from "langchain";
import { afterEach, beforeEach, describe, test } from "vitest";
import { z } from "zod";
import {
  ScriptedChatModel,
  toolCallsThenDone,
} from "../../../../test/chat-model";
import {
  adaptMessagesEvent,
  adaptToolArgDelta,
  adaptToolsEvent,
  adoptV3RunStream,
  interruptsToLegacyUpdatesPayload,
  isSerializedInterruptMessage,
  unwrapCustomEvent,
} from "./v3-protocol";

test("adaptToolArgDelta extracts a tool_call_chunk fragment", () => {
  const delta = adaptToolArgDelta({
    event: "content-block-delta",
    index: 2,
    delta: {
      type: "block-delta",
      fields: {
        type: "tool_call_chunk",
        id: "call_9",
        name: "write_file",
        args: '{"content":"pri',
      },
    },
  });
  assert.deepEqual(delta, {
    index: 2,
    id: "call_9",
    name: "write_file",
    args: '{"content":"pri',
  });
});

test("adaptToolArgDelta ignores text/reasoning deltas", () => {
  assert.equal(
    adaptToolArgDelta({
      event: "content-block-delta",
      delta: { type: "text-delta", text: "hi" },
    }),
    null,
  );
  assert.equal(adaptToolArgDelta({ event: "message-start" }), null);
});

test("adaptToolsEvent maps tool-started to on_tool_start with parsed input", () => {
  const names = new Map<string, string>();
  const legacy = adaptToolsEvent(
    {
      event: "tool-started",
      tool_call_id: "call_1",
      tool_name: "search",
      input: '{"query":"hi"}',
    },
    names,
  );
  assert.deepEqual(legacy, {
    event: "on_tool_start",
    name: "search",
    toolCallId: "call_1",
    input: { query: "hi" },
  });
  assert.equal(names.get("call_1"), "search");
});

test("adaptToolsEvent recovers tool name for tool-finished from the started map", () => {
  const names = new Map<string, string>([["call_1", "search"]]);
  const legacy = adaptToolsEvent(
    { event: "tool-finished", tool_call_id: "call_1", output: "plain result" },
    names,
  );
  assert.deepEqual(legacy, {
    event: "on_tool_end",
    name: "search",
    toolCallId: "call_1",
    output: "plain result",
  });
});

test("adaptToolsEvent extracts the artifact from a content_and_artifact ToolMessage", () => {
  const names = new Map<string, string>([["call_2", "connector"]]);
  const legacy = adaptToolsEvent(
    {
      event: "tool-finished",
      tool_call_id: "call_2",
      output: {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "ToolMessage"],
        kwargs: {
          content: "Human readable summary",
          artifact: { error: { code: "denied" } },
          status: "success",
        },
      },
    },
    names,
  );
  assert.equal(legacy?.event, "on_tool_end");
  assert.deepEqual(legacy?.output, { error: { code: "denied" } });
});

test("adaptToolsEvent parses JSON content of an artifact-less ToolMessage", () => {
  const names = new Map<string, string>([["call_3", "tool"]]);
  const legacy = adaptToolsEvent(
    {
      event: "tool-finished",
      tool_call_id: "call_3",
      output: {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "ToolMessage"],
        kwargs: { content: '{"ok":true}', status: "success" },
      },
    },
    names,
  );
  assert.deepEqual(legacy?.output, { ok: true });
});

for (const error of [
  "[AGENT_TOOL_EXECUTION_TIMEOUT] Tool 'render_video' timed out after 120000ms.",
  "[AGENT_TOOL_TERMINATION_UNKNOWN] Tool 'render_video' could not confirm remote termination.",
]) {
  test(`adaptToolsEvent preserves an error ToolMessage as tool-error: ${error.split("]")[0]}]`, () => {
    const names = new Map<string, string>([["call_error", "render_video"]]);
    const message = new ToolMessage({
      content: error,
      name: "render_video",
      status: "error",
      tool_call_id: "call_error",
    });

    const legacy = adaptToolsEvent(
      {
        event: "tool-finished",
        tool_call_id: "call_error",
        output: message.toJSON(),
      },
      names,
    );

    assert.deepEqual(legacy, {
      event: "on_tool_error",
      name: "render_video",
      toolCallId: "call_error",
      error,
    });
  });
}

test("adaptToolsEvent maps tool-error to on_tool_error", () => {
  const legacy = adaptToolsEvent(
    { event: "tool-error", tool_call_id: "call_4", message: "boom" },
    new Map([["call_4", "tool"]]),
  );
  assert.deepEqual(legacy, {
    event: "on_tool_error",
    name: "tool",
    toolCallId: "call_4",
    error: "boom",
  });
});

test("adaptToolsEvent drops events without a tool_call_id", () => {
  assert.equal(adaptToolsEvent({ event: "tool-started" }, new Map()), null);
});

test("adaptMessagesEvent emits an assistant text chunk for a text-delta", () => {
  const payloads = adaptMessagesEvent({
    event: "content-block-delta",
    index: 0,
    delta: { type: "text-delta", text: "Hello " },
  });
  assert.deepEqual(payloads, [[{ role: "assistant", content: "Hello " }, {}]]);
});

test("adaptMessagesEvent emits a reasoning-bearing chunk for a reasoning-delta", () => {
  const payloads = adaptMessagesEvent({
    event: "content-block-delta",
    index: 0,
    delta: { type: "reasoning-delta", reasoning: "Let me think" },
  });
  assert.deepEqual(payloads, [
    [{ role: "assistant", content: "", reasoning: "Let me think" }, {}],
  ]);
});

test("adaptMessagesEvent drops tool_call chunks and lifecycle events", () => {
  assert.deepEqual(
    adaptMessagesEvent({
      event: "content-block-delta",
      delta: {
        type: "block-delta",
        fields: { type: "tool_call_chunk", args: "{" },
      },
    }),
    [],
  );
  assert.deepEqual(adaptMessagesEvent({ event: "message-start", id: "0" }), []);
  assert.deepEqual(
    adaptMessagesEvent({ event: "message-finish", usage: { input_tokens: 1 } }),
    [],
  );
});

test("unwrapCustomEvent unwraps the v3 { payload } envelope", () => {
  assert.deepEqual(unwrapCustomEvent({ payload: { stage: "planning" } }), {
    stage: "planning",
  });
  // Already-unwrapped data passes through.
  assert.deepEqual(unwrapCustomEvent({ stage: "x" }), { stage: "x" });
});

test("interruptsToLegacyUpdatesPayload reshapes run.interrupts into __interrupt__", () => {
  const payload = interruptsToLegacyUpdatesPayload([
    { interruptId: "int-1", payload: { type: "ask_user" } },
    { payload: { actionRequests: [] } },
  ]);
  assert.deepEqual(payload, {
    __interrupt__: [
      { id: "int-1", value: { type: "ask_user" } },
      { value: { actionRequests: [] } },
    ],
  });
});

test("interruptsToLegacyUpdatesPayload collapses a delegate interrupt reported twice", () => {
  // A `task` delegate's interrupt surfaces from its subgraph and again as it
  // bubbles through the parent, under the same id.
  const request = {
    actionRequests: [{ name: "send_gmail_message", args: {} }],
  };
  const payload = interruptsToLegacyUpdatesPayload([
    { interruptId: "int-1", payload: request },
    { interruptId: "int-1", payload: request },
    { interruptId: "int-2", payload: request },
  ]);
  assert.deepEqual(
    payload.__interrupt__.map((entry) => entry.id),
    ["int-1", "int-2"],
  );
});

test("isSerializedInterruptMessage recognizes a GraphInterrupt's message", () => {
  const interrupt = new GraphInterrupt([
    { id: "int-1", value: { actionRequests: [] } },
  ]);
  assert.equal(isSerializedInterruptMessage(interrupt.message), true);
});

test("isSerializedInterruptMessage rejects ordinary tool errors", () => {
  for (const message of [
    "boom",
    "[AGENT_TOOL_EXECUTION_TIMEOUT] Tool 'render_video' timed out.",
    "[]",
    '[{"value":1}]',
    '[{"id":"x"}]',
    '["x"]',
    undefined,
  ]) {
    assert.equal(isSerializedInterruptMessage(message), false, String(message));
  }
});

describe("v3-tool-error-rejection", () => {
  // A tool that throws — a sandbox that could not be reached — must not be able
  // to end the PROCESS. It did: found when one connection reset to the sandbox
  // provider during an e2e run took the whole API down. This runs the installed
  // langchain/deepagents with a scripted model; no network.

  /** Calls `boom` once, then says done. */
  const oneFailingToolCallModel = () =>
    new ScriptedChatModel(
      toolCallsThenDone([{ id: "call-boom", name: "boom", args: {} }]),
      { name: "one-failing-tool-call" },
    );

  const boom = tool(
    async () => {
      throw new Error("SANDBOX_NOT_READY_OR_UNHEALTHY: provider unavailable");
    },
    { name: "boom", description: "always fails", schema: z.object({}) },
  );

  let unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  // vitest installs its own listener that fails the run; take it off for the
  // duration so the test can OBSERVE the rejection instead of dying from it.
  let parked: NodeJS.UnhandledRejectionListener[] = [];

  beforeEach(() => {
    unhandled = [];
    parked = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", record);
  });
  afterEach(() => {
    process.removeAllListeners("unhandledRejection");
    for (const listener of parked) process.on("unhandledRejection", listener);
  });

  async function runFailingTurn(adopt: (raw: unknown) => unknown) {
    const agent = createDeepAgent({
      model: oneFailingToolCallModel() as never,
      tools: [boom],
      checkpointer: new MemorySaver(),
    });
    const stream = adopt(
      await agent.streamEvents(
        { messages: [{ role: "user", content: "go" }] },
        {
          configurable: { thread_id: `boom-${Math.random()}` },
          version: "v3",
        } as never,
      ),
    ) as AsyncIterable<{ method?: string }>;
    const methods: string[] = [];
    try {
      for await (const event of stream) {
        if (typeof event?.method === "string") methods.push(event.method);
      }
    } catch {
      // The run itself may surface the tool error; that is handled by callers.
    }
    // `unhandledRejection` is raised after the microtask queue drains.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return methods;
  }

  test("reading only the event stream leaves the tool's rejected output promise unhandled", async () => {
    await runFailingTurn((raw) => raw);
    assert.ok(
      unhandled.length > 0,
      "expected the raw v3 stream to leak an unhandled rejection — if langchain fixed this upstream, adoptV3RunStream's guard can go",
    );
    assert.match(String(unhandled[0]), /SANDBOX_NOT_READY_OR_UNHEALTHY/);
  });

  test("adoptV3RunStream observes it, so a failing tool cannot take the process down", async () => {
    await runFailingTurn(adoptV3RunStream);
    assert.deepEqual(unhandled, []);
  });
});
