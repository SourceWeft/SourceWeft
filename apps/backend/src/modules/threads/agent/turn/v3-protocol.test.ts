import assert from "node:assert/strict";
import { test } from "vitest";
import {
  adaptMessagesEvent,
  adaptToolsEvent,
  interruptsToLegacyUpdatesPayload,
  unwrapCustomEvent,
} from "./v3-protocol";

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
      delta: { type: "block-delta", fields: { type: "tool_call_chunk", args: "{" } },
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
