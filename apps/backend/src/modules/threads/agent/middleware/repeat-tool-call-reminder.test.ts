import assert from "node:assert/strict";
import { test } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { maxConsecutiveRepeatSinceLastUser } from "./repeat-tool-call-reminder";

function ai(toolCalls: Array<{ name: string; args: unknown }>) {
  return new AIMessage({
    content: "",
    tool_calls: toolCalls.map((c, i) => ({
      id: `call_${i}`,
      name: c.name,
      args: c.args as Record<string, unknown>,
    })),
  });
}

test("counts consecutive identical tool calls at the tail", () => {
  const repeat = maxConsecutiveRepeatSinceLastUser([
    new HumanMessage("go"),
    ai([{ name: "searchSources", args: { q: "x" } }]),
    ai([{ name: "searchSources", args: { q: "x" } }]),
    ai([{ name: "searchSources", args: { q: "x" } }]),
  ]);
  assert.ok(repeat);
  assert.equal(repeat.name, "searchSources");
  assert.equal(repeat.count, 3);
});

test("argument key order does not change the signature", () => {
  const repeat = maxConsecutiveRepeatSinceLastUser([
    ai([{ name: "askUser", args: { a: 1, b: 2 } }]),
    ai([{ name: "askUser", args: { b: 2, a: 1 } }]),
  ]);
  assert.equal(repeat?.count, 2);
});

test("a human turn resets the run", () => {
  const repeat = maxConsecutiveRepeatSinceLastUser([
    ai([{ name: "grep", args: { p: "x" } }]),
    ai([{ name: "grep", args: { p: "x" } }]),
    new HumanMessage("new request"),
    ai([{ name: "grep", args: { p: "x" } }]),
  ]);
  assert.equal(repeat?.count, 1, "only the call after the last human counts");
});

test("different arguments break the run", () => {
  const repeat = maxConsecutiveRepeatSinceLastUser([
    ai([{ name: "searchSources", args: { q: "a" } }]),
    ai([{ name: "searchSources", args: { q: "b" } }]),
  ]);
  assert.equal(repeat?.count, 1);
});

test("no tool calls yields null", () => {
  assert.equal(
    maxConsecutiveRepeatSinceLastUser([new HumanMessage("hi")]),
    null,
  );
});
