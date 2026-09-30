import assert from "node:assert/strict";
import { test } from "vitest";
import { createDeltaCoalescer } from "./sse-coalescer";

function harness(flushMs = 80) {
  let clock = 1_000;
  const flushed: Array<Record<string, unknown>> = [];
  const coalescer = createDeltaCoalescer({
    flushMs,
    now: () => clock,
    flush: async (payload) => {
      flushed.push(payload);
    },
  });
  return {
    coalescer,
    flushed,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const text = (delta: string) => ({ type: "text-delta", id: "t", delta });
const reasoning = (segmentId: string, chunk: string, durationMs: number) => ({
  type: "reasoning",
  reasoning: chunk,
  segment: { id: segmentId, sequence: 1, durationMs, phase: "initial" },
});

test("text deltas inside the window persist as one event", async () => {
  const { coalescer, flushed, tick } = harness();
  assert.equal(await coalescer.push(text("Hel")), true);
  tick(10);
  assert.equal(await coalescer.push(text("lo")), true);
  assert.deepEqual(flushed, []);
  tick(80);
  assert.equal(await coalescer.push(text("!")), true);
  assert.deepEqual(flushed, [{ type: "text-delta", id: "t", delta: "Hello!" }]);
});

test("reasoning deltas of one segment inside the window persist as one event, with the latest segment", async () => {
  const { coalescer, flushed, tick } = harness();
  assert.equal(await coalescer.push(reasoning("s1", "Let", 5)), true);
  tick(20);
  assert.equal(await coalescer.push(reasoning("s1", " me", 25)), true);
  tick(20);
  assert.equal(await coalescer.push(reasoning("s1", " think", 45)), true);
  assert.deepEqual(flushed, []);
  await coalescer.flush();
  assert.deepEqual(flushed, [
    {
      type: "reasoning",
      reasoning: "Let me think",
      segment: { id: "s1", sequence: 1, durationMs: 45, phase: "initial" },
    },
  ]);
});

test("a new reasoning segment flushes the previous one first, in order", async () => {
  const { coalescer, flushed } = harness();
  await coalescer.push(reasoning("s1", "one", 1));
  await coalescer.push(reasoning("s2", "two", 1));
  assert.deepEqual(
    flushed.map((p) => [p.reasoning, (p.segment as { id: string }).id]),
    [["one", "s1"]],
  );
  await coalescer.flush();
  assert.deepEqual(
    flushed.map((p) => [p.reasoning, (p.segment as { id: string }).id]),
    [
      ["one", "s1"],
      ["two", "s2"],
    ],
  );
});

test("switching between reasoning and text keeps stream order", async () => {
  const { coalescer, flushed } = harness();
  await coalescer.push(reasoning("s1", "think", 1));
  await coalescer.push(text("answer"));
  await coalescer.push(reasoning("s2", "more", 1));
  await coalescer.flush();
  assert.deepEqual(
    flushed.map((p) => p.type),
    ["reasoning", "text-delta", "reasoning"],
  );
  assert.equal(flushed[0]!.reasoning, "think");
  assert.equal(flushed[1]!.delta, "answer");
  assert.equal(flushed[2]!.reasoning, "more");
});

test("a non-delta event flushes what is pending and is left to the caller", async () => {
  const { coalescer, flushed } = harness();
  await coalescer.push(text("partial"));
  assert.equal(
    await coalescer.push({ type: "tool-call-start", id: "call-1" }),
    false,
  );
  assert.deepEqual(flushed, [{ type: "text-delta", id: "t", delta: "partial" }]);
  // Nothing pending: the next flush is a no-op.
  await coalescer.flush();
  assert.equal(flushed.length, 1);
});

test("a payload that is not a delta is never buffered", async () => {
  const { coalescer, flushed } = harness();
  assert.equal(await coalescer.push(null), false);
  assert.equal(await coalescer.push({ type: "reasoning" }), false);
  assert.equal(
    await coalescer.push({ type: "reasoning", reasoning: "x", segment: {} }),
    false,
  );
  await coalescer.flush();
  assert.deepEqual(flushed, []);
});
