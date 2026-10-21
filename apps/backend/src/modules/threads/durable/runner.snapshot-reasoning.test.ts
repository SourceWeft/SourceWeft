import assert from "node:assert/strict";
import { test } from "vitest";
import {
  canApplyReasoningWrite,
  projectReasoning,
} from "../turn/reasoning-state";
import {
  MAX_REASONING_SEGMENT_CHARS,
  MAX_SNAPSHOT_REASONING_CHARS,
  boundReasoningRenderBlocks,
  boundReasoningText,
  boundSnapshotReasoning,
} from "./reasoning-bounds";
import { testExports } from "./runner";
import type { ChatRunSnapshot } from "./types";

type TraceEvent = {
  chars?: number;
  displayOrder?: number;
  id: string;
  itemId?: string;
  reasoning?: string;
  type: string;
};

type ReasoningBlock = { id: string; type: string; text?: string };

function streamSegment(input: {
  snapshot: ChatRunSnapshot;
  segmentId: string;
  sequence: number;
  phase?: "initial" | "after_tool";
  deltas: Iterable<string>;
}) {
  let snapshot = input.snapshot;
  for (const delta of input.deltas) {
    snapshot = testExports.updateSnapshotFromPayload(snapshot, {
      type: "reasoning",
      reasoning: delta,
      // The SSE segment carries no `text`, as the stream event mapper emits it.
      segment: {
        id: input.segmentId,
        sequence: input.sequence,
        phase: input.phase ?? "initial",
      },
    });
  }
  return snapshot;
}

function* repeatDelta(delta: string, count: number) {
  for (let i = 0; i < count; i++) yield delta;
}

function traceEvents(snapshot: ChatRunSnapshot) {
  return (snapshot.traceEvents ?? []) as TraceEvent[];
}

function reasoningBlocks(snapshot: ChatRunSnapshot) {
  return ((snapshot.renderBlocks ?? []) as ReasoningBlock[]).filter(
    (block) => block.type === "reasoning",
  );
}

test("13,000 reasoning deltas of one segment persist as one trace event and one render block", () => {
  const delta = "tok ";
  const deltaCount = 13_000;
  const snapshot = streamSegment({
    snapshot: {},
    segmentId: "model-reasoning-1",
    sequence: 1,
    deltas: repeatDelta(delta, deltaCount),
  });
  const fullText = delta.repeat(deltaCount);

  const events = traceEvents(snapshot);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "reasoning");
  assert.equal(events[0]?.id, "model-reasoning-1:1:initial:reasoning");
  assert.equal(events[0]?.itemId, "model-reasoning-1");
  assert.equal(events[0]?.chars, fullText.length);
  assert.equal(
    events[0]?.reasoning,
    undefined,
    "per-delta reasoning text is not copied into trace events",
  );

  const blocks = reasoningBlocks(snapshot);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.text, fullText);
  assert.equal(snapshot.reasoning, fullText);
  assert.equal(snapshot.reasoningRevision, deltaCount);
  assert.equal(snapshot.reasoningSegments?.length, 1);

  const serialized = JSON.stringify(snapshot).length;
  assert.ok(
    serialized < 200_000,
    `snapshot serialized to ${serialized} chars for ${fullText.length} chars of reasoning`,
  );
});

test("a segment boundary yields a second reasoning trace event", () => {
  let snapshot = streamSegment({
    snapshot: {},
    segmentId: "model-reasoning-1",
    sequence: 1,
    deltas: repeatDelta("a", 500),
  });
  snapshot = testExports.updateSnapshotFromPayload(snapshot, {
    type: "tool-call-result",
    id: "search-page",
    tool: "search_notion_pages",
    toolCall: {
      id: "search-page",
      tool: "search_notion_pages",
      input: {},
      output: null,
      status: "completed",
      sequence: 2,
    },
  });
  snapshot = streamSegment({
    snapshot,
    segmentId: "model-reasoning-2",
    sequence: 3,
    phase: "after_tool",
    deltas: repeatDelta("b", 500),
  });

  assert.deepEqual(
    traceEvents(snapshot).map(
      (event) => `${event.displayOrder}:${event.type}:${event.id}`,
    ),
    [
      "0:reasoning:model-reasoning-1:1:initial:reasoning",
      "1:tool-call:search-page:2:tool-call-result:1",
      "2:reasoning:model-reasoning-2:3:after_tool:reasoning",
    ],
  );
  assert.deepEqual(
    reasoningBlocks(snapshot).map((block) => `${block.id}:${block.text}`),
    [
      `reasoning-model-reasoning-1:${"a".repeat(500)}`,
      `reasoning-model-reasoning-2:${"b".repeat(500)}`,
    ],
  );
});

test("an upserted reasoning event keeps the first delta's displayOrder", () => {
  let snapshot = streamSegment({
    snapshot: {},
    segmentId: "model-reasoning-1",
    sequence: 1,
    deltas: ["first "],
  });
  snapshot = testExports.updateSnapshotFromPayload(snapshot, {
    type: "thinking-step",
    step: { id: "step-1", sequence: 2, title: "Plan", status: "running" },
  });
  snapshot = streamSegment({
    snapshot,
    segmentId: "model-reasoning-1",
    sequence: 1,
    deltas: repeatDelta("more ", 50),
  });

  const events = traceEvents(snapshot);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "reasoning");
  assert.equal(events[0]?.displayOrder, 0);
  assert.equal(events[0]?.chars, "first ".length + "more ".length * 50);
  assert.equal(events[1]?.type, "thinking-step");
  assert.equal(events[1]?.displayOrder, 1);
});

test("the segment cap keeps the tail of one over-long reasoning segment behind a marker", () => {
  const delta = "0123456789";
  const deltaCount = 7_000; // 70,000 chars > MAX_REASONING_SEGMENT_CHARS
  const snapshot = streamSegment({
    snapshot: {},
    segmentId: "model-reasoning-1",
    sequence: 1,
    deltas: repeatDelta(delta, deltaCount),
  });
  const fullText = delta.repeat(deltaCount);

  const [block] = reasoningBlocks(snapshot);
  assert.ok(block?.text);
  assert.ok(block.text.length <= MAX_REASONING_SEGMENT_CHARS);
  const marker = /^…\[reasoning truncated: (\d+) chars dropped\]/u.exec(
    block.text,
  );
  assert.ok(marker, "render block starts with the truncation marker");
  const dropped = Number(marker[1]);
  assert.equal(
    block.text.slice(marker[0].length),
    fullText.slice(dropped),
    "the kept tail is the end of the full text, counted from the marker",
  );
  assert.equal(marker[0].length + fullText.length - dropped, block.text.length);

  // The snapshot-level text is under its own (larger) cap and stays whole.
  assert.equal(snapshot.reasoning, fullText);
  assert.equal(traceEvents(snapshot).length, 1);
  assert.equal(traceEvents(snapshot)[0]?.chars, fullText.length);
});

test("the snapshot cap keeps the tail of the accumulated reasoning across segments", () => {
  const delta = "abcdefghij";
  const perSegment = 6_000; // 60,000 chars per segment, under the segment cap
  const segments = 5; // 300,000 chars total > MAX_SNAPSHOT_REASONING_CHARS
  let snapshot: ChatRunSnapshot = {};
  let fullText = "";
  for (let index = 0; index < segments; index++) {
    snapshot = streamSegment({
      snapshot,
      segmentId: `model-reasoning-${index + 1}`,
      sequence: index + 1,
      phase: index === 0 ? "initial" : "after_tool",
      deltas: repeatDelta(delta, perSegment),
    });
    fullText += delta.repeat(perSegment);
  }

  assert.ok(snapshot.reasoning);
  assert.ok(snapshot.reasoning.length <= MAX_SNAPSHOT_REASONING_CHARS);
  const marker = /^…\[reasoning truncated: (\d+) chars dropped\]/u.exec(
    snapshot.reasoning,
  );
  assert.ok(marker, "snapshot reasoning starts with the truncation marker");
  const dropped = Number(marker[1]);
  assert.equal(
    snapshot.reasoning.slice(marker[0].length),
    fullText.slice(dropped),
    "the marker count is cumulative across re-bounding, so it indexes the full text",
  );
  assert.equal(snapshot.reasoningRevision, perSegment * segments);

  // Every segment keeps its own whole render block and one trace event.
  assert.equal(reasoningBlocks(snapshot).length, segments);
  for (const block of reasoningBlocks(snapshot)) {
    assert.equal(block.text, delta.repeat(perSegment));
  }
  assert.equal(traceEvents(snapshot).length, segments);
});

test("boundReasoningText is a no-op under the limit and deterministic over it", () => {
  assert.equal(boundReasoningText("short", 10), "short");
  assert.equal(boundReasoningText("", 10), "");

  const text = "x".repeat(100) + "TAIL";
  const bounded = boundReasoningText(text, 80);
  assert.ok(bounded.length <= 80);
  assert.ok(bounded.endsWith("TAIL"));
  assert.match(bounded, /^…\[reasoning truncated: \d+ chars dropped\]x+TAIL$/u);
  assert.equal(boundReasoningText(text, 80), bounded, "pure");
  assert.equal(boundReasoningText(bounded, 80), bounded, "idempotent");

  // Re-bounding after appending keeps the cumulative dropped count.
  const once = boundReasoningText("a".repeat(100), 80);
  const twice = boundReasoningText(`${once}${"b".repeat(10)}`, 80);
  const onceDropped = Number(
    /reasoning truncated: (\d+) chars dropped/u.exec(once)?.[1],
  );
  const twiceDropped = Number(
    /reasoning truncated: (\d+) chars dropped/u.exec(twice)?.[1],
  );
  assert.ok(twiceDropped > onceDropped);
  assert.ok(twice.length <= 80);
  assert.ok(twice.endsWith("b".repeat(10)));
  assert.equal(
    twice.slice(
      /^…\[reasoning truncated: \d+ chars dropped\]/u.exec(twice)![0].length,
    ),
    `${"a".repeat(100)}${"b".repeat(10)}`.slice(twiceDropped),
  );

  assert.throws(() => boundReasoningText("x", 0), RangeError);
});

test("the snapshot path and a one-shot terminal bound of the same text are identical", () => {
  const delta = "abcdefghij";
  const perSegment = 7_000; // 70,000 chars per segment, over the segment cap
  const segments = 4; // 280,000 chars total, over the snapshot cap
  let snapshot: ChatRunSnapshot = {};
  let fullText = "";
  for (let index = 0; index < segments; index++) {
    snapshot = streamSegment({
      snapshot,
      segmentId: `model-reasoning-${index + 1}`,
      sequence: index + 1,
      deltas: repeatDelta(delta, perSegment),
    });
    fullText += delta.repeat(perSegment);
  }

  // What the finalizer / stream error writer project from the unbounded
  // runtime text must equal what the durable runner accumulated delta by delta.
  assert.equal(snapshot.reasoning, boundSnapshotReasoning(fullText));
  assert.deepEqual(
    reasoningBlocks(snapshot).map((block) => block.text),
    boundReasoningRenderBlocks(
      reasoningBlocks(snapshot).map((block) => ({
        id: block.id,
        type: "reasoning" as const,
        text: delta.repeat(perSegment),
      })),
    ).map((block) => block.text),
  );
  const tool = { id: "tool-1", type: "tool" as const, toolCallId: "call-1" };
  const [sameTool] = boundReasoningRenderBlocks([tool]);
  assert.equal(sameTool, tool, "non-reasoning blocks pass through untouched");
});

test("a terminal write of over-limit reasoning is not rejected by the reasoningWrite CAS", () => {
  const run = { runId: "run-1", parentRunId: null, base: "" };
  const delta = "0123456789abcdef";
  const deltas = 20_000; // 320,000 chars > MAX_SNAPSHOT_REASONING_CHARS
  const runtimeText = delta.repeat(deltas);
  const snapshot = streamSegment({
    snapshot: { reasoningRun: run },
    segmentId: "model-reasoning-1",
    sequence: 1,
    deltas: repeatDelta(delta, deltas),
  });

  // createDurableErrorMessage / createThreadStreamErrorMessage / finalizer:
  // terminal projection of the runtime partial state.
  const terminalFromRuntime = projectReasoning({
    run,
    text: boundSnapshotReasoning(runtimeText),
    terminal: true,
  });
  // persistTerminalFailure afterwards: terminal projection of the snapshot.
  const terminalFromSnapshot = projectReasoning({
    run,
    text: snapshot.reasoning,
    terminal: true,
  });
  assert.equal(
    canApplyReasoningWrite(terminalFromRuntime, terminalFromSnapshot),
    true,
  );
  assert.equal(terminalFromRuntime.reasoning, terminalFromSnapshot.reasoning);

  // Control: projecting the unbounded runtime text is exactly the write the
  // CAS would reject at the equal terminal revision.
  const unboundedTerminal = projectReasoning({
    run,
    text: runtimeText,
    terminal: true,
  });
  assert.equal(
    canApplyReasoningWrite(unboundedTerminal, terminalFromSnapshot),
    false,
  );
});

test("text starting with the plain tool-output truncation literal is ordinary text", () => {
  const echoed = `…[truncated 5 chars]${"x".repeat(100)}`;
  const bounded = boundReasoningText(echoed, 60);
  assert.ok(bounded.length <= 60);
  const marker = /^…\[reasoning truncated: (\d+) chars dropped\]/u.exec(
    bounded,
  );
  assert.ok(marker);
  // The literal counts as dropped text; its "5" is not parsed as a prior count.
  assert.equal(
    Number(marker[1]),
    echoed.length - (bounded.length - marker[0].length),
  );
  assert.equal(
    bounded.slice(marker[0].length),
    echoed.slice(Number(marker[1])),
  );
  assert.equal(
    boundReasoningText(echoed, 1_000),
    echoed,
    "untouched under the limit",
  );
});

test("a limit smaller than the marker returns the marker cut to the limit", () => {
  const text = "y".repeat(80);
  const bounded = boundReasoningText(text, 10);
  assert.equal(bounded.length, 10);
  assert.equal(
    bounded,
    "…[reasoning truncated: 80 chars dropped]".slice(0, 10),
  );
});
