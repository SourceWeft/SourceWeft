import assert from "node:assert/strict";
import { test } from "vitest";
import type { ModelReasoningSegmentTrace } from "../turn/types";
import { upsertReasoningSegmentTrace } from "./run-trace-state";

// The runtime's segments always carry `text`, but the merge is by id only, so
// the shape without text must still merge; the trace type declares it required.
function segment(
  input: Partial<ModelReasoningSegmentTrace> & { id: string },
): ModelReasoningSegmentTrace {
  return { sequence: 0, ...input } as ModelReasoningSegmentTrace;
}

test("same segment id arriving twice without text merges into one entry", () => {
  const segmentsById = new Map<string, ModelReasoningSegmentTrace>();
  upsertReasoningSegmentTrace(
    segmentsById,
    segment({ id: "seg-1", sequence: 1, durationMs: 10 }),
  );
  upsertReasoningSegmentTrace(
    segmentsById,
    segment({ id: "seg-1", sequence: 1, durationMs: 25 }),
  );

  assert.deepEqual([...segmentsById.keys()], ["seg-1"]);
  assert.equal(segmentsById.get("seg-1")?.durationMs, 25);
  assert.equal(segmentsById.has("seg-1:2"), false);
});

test("existing text is preserved when the next event lacks text", () => {
  const segmentsById = new Map<string, ModelReasoningSegmentTrace>();
  upsertReasoningSegmentTrace(
    segmentsById,
    segment({ id: "seg-1", sequence: 1, text: "thinking…", phase: "initial" }),
  );
  upsertReasoningSegmentTrace(
    segmentsById,
    segment({ id: "seg-1", sequence: 1, durationMs: 40 }),
  );

  assert.equal(segmentsById.size, 1);
  assert.deepEqual(segmentsById.get("seg-1"), {
    id: "seg-1",
    sequence: 1,
    text: "thinking…",
    phase: "initial",
    durationMs: 40,
  });
});

test("a later event carrying text updates the stored text", () => {
  const segmentsById = new Map<string, ModelReasoningSegmentTrace>();
  upsertReasoningSegmentTrace(
    segmentsById,
    segment({ id: "seg-1", sequence: 1, text: "first" }),
  );
  upsertReasoningSegmentTrace(
    segmentsById,
    segment({ id: "seg-1", sequence: 1, text: "first second" }),
  );

  assert.equal(segmentsById.size, 1);
  assert.equal(segmentsById.get("seg-1")?.text, "first second");
});

test("the first sequence seen for a segment id is kept", () => {
  const segmentsById = new Map<string, ModelReasoningSegmentTrace>();
  upsertReasoningSegmentTrace(
    segmentsById,
    segment({ id: "seg-1", sequence: 3 }),
  );
  upsertReasoningSegmentTrace(
    segmentsById,
    segment({ id: "seg-1", sequence: 7 }),
  );

  assert.equal(segmentsById.get("seg-1")?.sequence, 3);
});

test("two different segment ids produce two entries in arrival order", () => {
  const segmentsById = new Map<string, ModelReasoningSegmentTrace>();
  upsertReasoningSegmentTrace(
    segmentsById,
    segment({
      id: "seg-b",
      sequence: 2,
      phase: "after_tool",
      toolCallId: "t1",
    }),
  );
  upsertReasoningSegmentTrace(
    segmentsById,
    segment({ id: "seg-a", sequence: 1, phase: "initial" }),
  );
  upsertReasoningSegmentTrace(
    segmentsById,
    segment({ id: "seg-b", sequence: 2 }),
  );

  assert.deepEqual([...segmentsById.keys()], ["seg-b", "seg-a"]);
  assert.deepEqual(
    [...segmentsById.values()].map((item) => item.id),
    ["seg-b", "seg-a"],
  );
  assert.equal(segmentsById.get("seg-b")?.toolCallId, "t1");
});
