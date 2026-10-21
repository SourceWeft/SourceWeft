import assert from "node:assert/strict";
import { test } from "vitest";
import { createDeltaCoalescer } from "./sse-coalescer";

function harness(flushMs = 80, initialWriteMs = 0) {
  let clock = 1_000;
  let writeMs = initialWriteMs;
  const flushed: Array<Record<string, unknown>> = [];
  const coalescer = createDeltaCoalescer({
    flushMs,
    now: () => clock,
    flush: async (payload) => {
      flushed.push(payload);
      clock += writeMs;
    },
  });
  return {
    coalescer,
    flushed,
    setWriteMs: (ms: number) => {
      writeMs = ms;
    },
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
  assert.deepEqual(flushed, [
    { type: "text-delta", id: "t", delta: "partial" },
  ]);
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

test("slow persistence collects lossless reasoning windows with the latest segment instead of paying one write per short window", async () => {
  const { coalescer, flushed, tick } = harness(80, 500);
  const chunks = Array.from({ length: 100 }, (_, index) => `${index},`);
  for (const [index, chunk] of chunks.entries()) {
    tick(10);
    await coalescer.push(reasoning("segment", chunk, (index + 1) * 10));
  }
  await coalescer.flush();
  assert.equal(
    flushed.map((payload) => payload.reasoning).join(""),
    chunks.join(""),
  );
  assert.equal(flushed.length, 3);
  assert.deepEqual(
    flushed.map(
      (payload) => (payload.segment as { durationMs: number }).durationMs,
    ),
    [90, 600, 1000],
  );
});

test("a slow write cannot extend the next collection window beyond one second", async () => {
  const { coalescer, flushed, tick } = harness(80, 5000);
  await coalescer.push(text("a"));
  tick(80);
  await coalescer.push(text("b"));
  assert.equal(flushed.length, 1);
  await coalescer.push(text("c"));
  tick(999);
  await coalescer.push(text("d"));
  assert.equal(flushed.length, 1);
  tick(1);
  await coalescer.push(text("e"));
  assert.deepEqual(
    flushed.map((payload) => payload.delta),
    ["ab", "cde"],
  );
});

test("a cheap successful write restores the base eighty millisecond window", async () => {
  const { coalescer, flushed, tick, setWriteMs } = harness(80, 500);
  await coalescer.push(text("a"));
  tick(80);
  await coalescer.push(text("b"));
  setWriteMs(0);
  await coalescer.push(text("c"));
  tick(499);
  await coalescer.push(text("d"));
  assert.equal(flushed.length, 1);
  tick(1);
  await coalescer.push(text("e"));
  await coalescer.push(text("f"));
  tick(79);
  await coalescer.push(text("g"));
  assert.equal(flushed.length, 2);
  tick(1);
  await coalescer.push(text("h"));
  assert.deepEqual(
    flushed.map((payload) => payload.delta),
    ["ab", "cde", "fgh"],
  );
});

test("the character bound flushes before time expires without accumulating past the limit", async () => {
  const { coalescer, flushed, tick } = harness(80, 2000);
  await coalescer.push(text("seed"));
  await coalescer.flush();
  await coalescer.push(text("a".repeat(4095)));
  tick(1);
  await coalescer.push(text("b"));
  assert.equal(flushed.length, 2);
  assert.equal((flushed[1]!.delta as string).length, 4096);
  await coalescer.push(text("c".repeat(4095)));
  await coalescer.push(text("dd"));
  assert.equal(flushed.length, 3);
  assert.equal(flushed[2]!.delta, "c".repeat(4095));
  await coalescer.flush();
  assert.equal(flushed[3]!.delta, "dd");
});

test("an oversized raw delta is flushed immediately without splitting or merging it", async () => {
  const { coalescer, flushed } = harness();
  await coalescer.push(reasoning("segment", "x".repeat(5000), 3));
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]!.reasoning, "x".repeat(5000));
  assert.equal((flushed[0]!.segment as { durationMs: number }).durationMs, 3);
  await coalescer.flush();
  assert.equal(flushed.length, 1);
});

test("slow persistence preserves segment, type, tool and final boundaries in stream order", async () => {
  const { coalescer, flushed, tick } = harness(80, 600);
  await coalescer.push(reasoning("s1", "one", 1));
  tick(10);
  const latest = reasoning("s1", " two", 11);
  latest.segment.phase = "latest";
  await coalescer.push(latest);
  await coalescer.push(reasoning("s2", "three", 1));
  await coalescer.push(text("answer"));
  const tool = { type: "tool-call-start", id: "call-1" };
  assert.equal(await coalescer.push(tool), false);
  flushed.push(tool);
  await coalescer.push(text(" tail"));
  const final = { type: "finish" };
  assert.equal(await coalescer.push(final), false);
  flushed.push(final);
  assert.deepEqual(
    flushed.map((payload) => payload.type),
    [
      "reasoning",
      "reasoning",
      "text-delta",
      "tool-call-start",
      "text-delta",
      "finish",
    ],
  );
  assert.equal(flushed[0]!.reasoning, "one two");
  assert.deepEqual(flushed[0]!.segment, latest.segment);
  assert.equal(flushed[1]!.reasoning, "three");
  assert.equal(flushed[2]!.delta, "answer");
  assert.equal(flushed[4]!.delta, " tail");
});

test("failed persistence propagates without increasing the next window", async () => {
  let clock = 1000;
  let calls = 0;
  const error = new Error("persist failed");
  const coalescer = createDeltaCoalescer({
    now: () => clock,
    flush: async () => {
      calls++;
      if (calls === 1) {
        clock += 2000;
        throw error;
      }
    },
  });
  await coalescer.push(text("before"));
  clock += 80;
  await assert.rejects(
    coalescer.push(text("failure")),
    (failure) => failure === error,
  );
  await coalescer.push(text("after"));
  clock += 79;
  await coalescer.push(text("cheap"));
  assert.equal(calls, 1);
  clock++;
  await coalescer.push(text("write"));
  assert.equal(calls, 2);
});

test("boundary and explicit final flush failures are awaited and propagated", async () => {
  const error = new Error("write rejected");
  const coalescer = createDeltaCoalescer({
    flush: async () => {
      throw error;
    },
  });
  await coalescer.push(reasoning("s1", "pending", 1));
  await assert.rejects(
    coalescer.push({ type: "tool-call-start" }),
    (failure) => failure === error,
  );
  await coalescer.push(text("final"));
  await assert.rejects(coalescer.flush(), (failure) => failure === error);
});

test("character-triggered persistence is awaited rather than started in the background", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed = false;
  const coalescer = createDeltaCoalescer({ flush: async () => gate });
  const push = coalescer.push(text("x".repeat(4096))).then(() => {
    completed = true;
  });
  await Promise.resolve();
  assert.equal(completed, false);
  release();
  await push;
  assert.equal(completed, true);
});

test("a segment reset is persisted after the deltas it withdraws, never buffered or reordered", async () => {
  const { coalescer, flushed } = harness();
  assert.equal(await coalescer.push(reasoning("A", "a1", 1)), true);
  assert.equal(await coalescer.push(reasoning("A", "a2", 2)), true);
  assert.equal(await coalescer.push(text("partial")), true);
  const reset = {
    type: "segment-reset",
    reason: "model_call_retry",
    attempt: 2,
    segmentIds: ["A"],
    toolCallIds: [],
    keepTextChars: 0,
    dropReasoningChars: 4,
    keepReasoningChars: 0,
  };
  // Not a delta: whatever was pending is flushed first and the caller appends
  // the reset itself, so the replay order is reasoning, text, reset.
  assert.equal(await coalescer.push(reset), false);
  assert.deepEqual(
    flushed.map((payload) => payload.type),
    ["reasoning", "text-delta"],
  );
  assert.equal(flushed[0]?.reasoning, "a1a2");
  assert.equal(await coalescer.push(reasoning("B", "b1", 3)), true);
  await coalescer.flush();
  assert.deepEqual(
    flushed.map((payload) => payload.type),
    ["reasoning", "text-delta", "reasoning"],
  );
});
