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
  boundReasoningSegmentText,
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

type ToolBlock = { id: string; type: string; toolCallId?: string };

function segmentReset(input: {
  segmentIds: string[];
  toolCallIds?: string[];
  keepTextChars: number;
  /** Reasoning chars the failed attempt streamed; the field the runner cuts by. */
  dropReasoningChars?: number;
  /** Pre-attempt runtime reasoning length; honoured only without a drop count. */
  keepReasoningChars?: number;
  attempt?: number;
}) {
  return {
    type: "segment-reset",
    reason: "model_call_retry",
    attempt: input.attempt ?? 2,
    segmentIds: input.segmentIds,
    toolCallIds: input.toolCallIds ?? [],
    keepTextChars: input.keepTextChars,
    ...(input.dropReasoningChars !== undefined
      ? { dropReasoningChars: input.dropReasoningChars }
      : {}),
    ...(input.keepReasoningChars !== undefined
      ? { keepReasoningChars: input.keepReasoningChars }
      : {}),
  };
}

function toolCallStart(id: string, sequence: number) {
  return {
    type: "tool-call-start",
    id,
    tool: "search_sources",
    input: { query: id },
    toolCall: {
      id,
      tool: "search_sources",
      input: { query: id },
      output: null,
      status: "running",
      latencyMs: null,
      error: null,
      sequence,
    },
  };
}

function toolCallResult(id: string, sequence: number) {
  return {
    type: "tool-call-result",
    id,
    tool: "search_sources",
    output: { hitCount: 1 },
    latencyMs: 5,
    toolCall: {
      id,
      tool: "search_sources",
      input: { query: id },
      output: { hitCount: 1 },
      status: "completed",
      latencyMs: 5,
      error: null,
      sequence,
    },
  };
}

function textDelta(delta: string) {
  return { type: "text-delta", id: "assistant", delta };
}

test("a segment reset withdraws the failed attempt's reasoning and text; the retry streams under a new segment", () => {
  let snapshot: ChatRunSnapshot = { reasoningRevision: 0 };
  snapshot = testExports.updateSnapshotFromPayload(
    snapshot,
    textDelta("Intro. "),
  );
  const preResetText = snapshot.assistantContent!;
  snapshot = streamSegment({
    snapshot,
    segmentId: "model-reasoning-A",
    sequence: 1,
    deltas: ["a1 ", "a2 ", "a3"],
  });
  snapshot = testExports.updateSnapshotFromPayload(
    snapshot,
    textDelta("partial answer the failed call started"),
  );
  const revisionBeforeReset = snapshot.reasoningRevision!;
  assert.equal(reasoningBlocks(snapshot).length, 1);
  assert.equal(snapshot.reasoning, "a1 a2 a3");

  snapshot = testExports.updateSnapshotFromPayload(
    snapshot,
    segmentReset({
      segmentIds: ["model-reasoning-A"],
      keepTextChars: preResetText.length,
      dropReasoningChars: "a1 a2 a3".length,
    }),
  );
  assert.ok(
    snapshot.reasoningRevision! > revisionBeforeReset,
    "the reset moves the revision forward so the CAS accepts the shorter text",
  );
  assert.equal(snapshot.reasoning, "");
  assert.equal(snapshot.assistantContent, preResetText);
  assert.deepEqual(reasoningBlocks(snapshot), []);
  assert.deepEqual(traceEvents(snapshot), []);
  assert.deepEqual(snapshot.reasoningSegments, []);
  assert.deepEqual(snapshot.traceParts, []);
  assert.deepEqual(snapshot.renderBlocks, [
    { id: "text-1", type: "text", text: preResetText },
  ]);

  const revisionAfterReset = snapshot.reasoningRevision!;
  snapshot = streamSegment({
    snapshot,
    segmentId: "model-reasoning-B",
    sequence: 2,
    deltas: ["b1 ", "b2"],
  });
  snapshot = testExports.updateSnapshotFromPayload(
    snapshot,
    textDelta("Done."),
  );

  assert.deepEqual(
    reasoningBlocks(snapshot).map((block) => `${block.id}:${block.text}`),
    ["reasoning-model-reasoning-B:b1 b2"],
  );
  assert.deepEqual(
    traceEvents(snapshot).map(
      (event) => `${event.displayOrder}:${event.type}:${event.itemId}`,
    ),
    ["0:reasoning:model-reasoning-B"],
  );
  assert.deepEqual(
    (snapshot.reasoningSegments as Array<{ id: string }>).map((s) => s.id),
    ["model-reasoning-B"],
  );
  assert.equal(snapshot.reasoning, "b1 b2");
  assert.equal(snapshot.assistantContent, `${preResetText}Done.`);
  assert.equal(snapshot.reasoningRevision, revisionAfterReset + 2);
  assert.deepEqual(
    (snapshot.traceParts as Array<{ kind: string; id: string }>).map(
      (part) => `${part.kind}:${part.id}`,
    ),
    ["reasoning:model-reasoning-B"],
  );
});

test("a reset keeps reasoning streamed by earlier successful calls and only withdraws the named segments", () => {
  let snapshot: ChatRunSnapshot = {};
  snapshot = streamSegment({
    snapshot,
    segmentId: "model-reasoning-1",
    sequence: 1,
    deltas: ["first call "],
  });
  snapshot = testExports.updateSnapshotFromPayload(
    snapshot,
    toolCallStart("search-1", 2),
  );
  snapshot = testExports.updateSnapshotFromPayload(
    snapshot,
    toolCallResult("search-1", 2),
  );
  snapshot = testExports.updateSnapshotFromPayload(
    snapshot,
    textDelta("Text."),
  );
  snapshot = streamSegment({
    snapshot,
    segmentId: "model-reasoning-2",
    sequence: 3,
    phase: "after_tool",
    deltas: ["second call failed"],
  });
  const eventsBefore = traceEvents(snapshot).map(
    (event) => `${event.displayOrder}:${event.type}:${event.itemId}`,
  );

  snapshot = testExports.updateSnapshotFromPayload(
    snapshot,
    segmentReset({
      segmentIds: ["model-reasoning-2"],
      keepTextChars: "Text.".length,
      // No drop count: the runner falls back to the pre-attempt length.
      keepReasoningChars: "first call ".length,
    }),
  );

  assert.equal(snapshot.reasoning, "first call ");
  assert.deepEqual(
    reasoningBlocks(snapshot).map((block) => block.id),
    ["reasoning-model-reasoning-1"],
  );
  // Survivors keep their displayOrder: nothing is renumbered.
  assert.deepEqual(
    traceEvents(snapshot).map(
      (event) => `${event.displayOrder}:${event.type}:${event.itemId}`,
    ),
    eventsBefore.filter((entry) => !entry.endsWith(":model-reasoning-2")),
  );
  assert.deepEqual(
    (snapshot.toolCalls as Array<{ id: string; status: string }>).map(
      (call) => `${call.id}:${call.status}`,
    ),
    ["search-1:completed"],
  );

  // A later event sorts after every survivor even though the array shrank.
  snapshot = streamSegment({
    snapshot,
    segmentId: "model-reasoning-3",
    sequence: 4,
    phase: "after_tool",
    deltas: ["retry"],
  });
  const orders = traceEvents(snapshot).map((event) => event.displayOrder!);
  assert.deepEqual(
    [...orders].sort((a, b) => a - b),
    orders,
  );
  assert.equal(new Set(orders).size, orders.length);
  assert.equal(snapshot.reasoning, "first call retry");
});

test("a reset removes a pending tool call but keeps a completed one named by mistake", () => {
  let snapshot: ChatRunSnapshot = {};
  snapshot = testExports.updateSnapshotFromPayload(
    snapshot,
    toolCallStart("done-call", 1),
  );
  snapshot = testExports.updateSnapshotFromPayload(
    snapshot,
    toolCallResult("done-call", 1),
  );
  snapshot = testExports.updateSnapshotFromPayload(
    snapshot,
    toolCallStart("pending-call", 2),
  );
  assert.equal(snapshot.toolCalls?.length, 2);
  assert.equal(snapshot.renderBlocks?.length, 2);

  snapshot = testExports.updateSnapshotFromPayload(
    snapshot,
    segmentReset({
      segmentIds: [],
      toolCallIds: ["pending-call", "done-call"],
      keepTextChars: 0,
      dropReasoningChars: 0,
    }),
  );

  assert.deepEqual(
    (snapshot.toolCalls as Array<{ id: string; status: string }>).map(
      (call) => `${call.id}:${call.status}`,
    ),
    ["done-call:completed"],
  );
  assert.deepEqual(
    (snapshot.renderBlocks as ToolBlock[]).map(
      (block) => `${block.type}:${block.toolCallId}`,
    ),
    ["tool:done-call"],
  );
  assert.deepEqual(
    traceEvents(snapshot).map((event) => `${event.type}:${event.itemId}`),
    ["tool-call:done-call", "tool-call:done-call"],
  );
  assert.deepEqual(
    (snapshot.traceParts as Array<{ kind: string; toolCallId?: string }>).map(
      (part) => `${part.kind}:${part.toolCallId}`,
    ),
    ["tool:done-call"],
  );
});

test("a reset naming an unknown segment changes nothing but the revision", () => {
  let snapshot: ChatRunSnapshot = { reasoningRevision: 0 };
  snapshot = testExports.updateSnapshotFromPayload(
    snapshot,
    textDelta("Hello"),
  );
  snapshot = streamSegment({
    snapshot,
    segmentId: "model-reasoning-1",
    sequence: 1,
    deltas: ["kept"],
  });
  snapshot = testExports.updateSnapshotFromPayload(snapshot, {
    type: "thinking-step",
    step: { id: "step-1", sequence: 2, title: "Plan", status: "running" },
  });
  const before = snapshot;

  const after = testExports.updateSnapshotFromPayload(
    before,
    segmentReset({
      segmentIds: ["model-reasoning-unknown"],
      toolCallIds: ["tool-unknown"],
      keepTextChars: before.assistantContent!.length,
      dropReasoningChars: 0,
    }),
  );

  assert.equal(after.reasoningRevision, before.reasoningRevision! + 1);
  const { reasoningRevision: _b, lastEventType: _lb, ...restBefore } = before;
  const { reasoningRevision: _a, lastEventType: _la, ...restAfter } = after;
  assert.deepEqual(restAfter, restBefore);
  assert.equal(after.lastEventType, "segment-reset");
});

test("a reset of a continuation run leaves the prior run's reasoning blocks and does not fold them into `reasoning`", () => {
  // On resume the runner seeds renderBlocks from the placeholder message; the
  // prior run's reasoning is in reasoningRun.base, not in this run's text.
  const priorBlock = {
    id: "reasoning-prior-run-segment",
    type: "reasoning",
    text: "prior run reasoning",
  };
  let snapshot: ChatRunSnapshot = {
    reasoningRun: {
      runId: "run-2",
      parentRunId: "run-1",
      base: "prior run reasoning",
    },
    reasoningRevision: 0,
    renderBlocks: [
      priorBlock,
      { id: "text-1", type: "text", text: "prior text" },
    ],
  };
  snapshot = streamSegment({
    snapshot,
    segmentId: "model-reasoning-A",
    sequence: 1,
    deltas: ["failed"],
  });
  snapshot = testExports.updateSnapshotFromPayload(snapshot, textDelta("new"));
  snapshot = testExports.updateSnapshotFromPayload(
    snapshot,
    segmentReset({
      segmentIds: ["model-reasoning-A"],
      keepTextChars: 0,
      dropReasoningChars: "failed".length,
    }),
  );

  assert.equal(snapshot.reasoning, "");
  assert.equal(snapshot.assistantContent, "");
  assert.deepEqual(snapshot.renderBlocks, [
    priorBlock,
    { id: "text-1", type: "text", text: "prior text" },
  ]);

  snapshot = streamSegment({
    snapshot,
    segmentId: "model-reasoning-B",
    sequence: 2,
    deltas: ["retried"],
  });
  assert.equal(snapshot.reasoning, "retried");
  assert.deepEqual(
    reasoningBlocks(snapshot).map((block) => block.id),
    ["reasoning-prior-run-segment", "reasoning-model-reasoning-B"],
  );
});

test("the reasoning bounds still hold after a reset of an over-long segment", () => {
  const delta = "0123456789";
  let snapshot: ChatRunSnapshot = { reasoningRevision: 0 };
  snapshot = streamSegment({
    snapshot,
    segmentId: "model-reasoning-A",
    sequence: 1,
    deltas: repeatDelta(delta, 7_000), // 70,000 chars > segment cap
  });
  assert.ok(
    reasoningBlocks(snapshot)[0]!.text!.length <= MAX_REASONING_SEGMENT_CHARS,
  );
  const revisionBeforeReset = snapshot.reasoningRevision!;

  snapshot = testExports.updateSnapshotFromPayload(
    snapshot,
    segmentReset({
      segmentIds: ["model-reasoning-A"],
      keepTextChars: 0,
      dropReasoningChars: 70_000,
    }),
  );
  assert.equal(snapshot.reasoning, "");
  assert.equal(reasoningBlocks(snapshot).length, 0);
  assert.equal(snapshot.reasoningRevision, revisionBeforeReset + 1);

  snapshot = streamSegment({
    snapshot,
    segmentId: "model-reasoning-B",
    sequence: 2,
    deltas: repeatDelta(delta, 7_000),
  });
  const [block] = reasoningBlocks(snapshot);
  assert.equal(reasoningBlocks(snapshot).length, 1);
  assert.ok(block!.text!.length <= MAX_REASONING_SEGMENT_CHARS);
  assert.match(block!.text!, /^…\[reasoning truncated: \d+ chars dropped\]/u);
  assert.equal(block!.text, boundReasoningSegmentText(delta.repeat(7_000)));
  assert.equal(snapshot.reasoning, boundSnapshotReasoning(delta.repeat(7_000)));
  assert.ok(snapshot.reasoning!.length <= MAX_SNAPSHOT_REASONING_CHARS);
  assert.equal(traceEvents(snapshot).length, 1);
  assert.equal(traceEvents(snapshot)[0]?.itemId, "model-reasoning-B");
});

test("a reset after the snapshot cap rebuilds `reasoning` bounded from the surviving segments", () => {
  const delta = "abcdefghij";
  let snapshot: ChatRunSnapshot = { reasoningRevision: 0 };
  // Five whole 60k segments: 300k > MAX_SNAPSHOT_REASONING_CHARS.
  for (let index = 0; index < 5; index++) {
    snapshot = streamSegment({
      snapshot,
      segmentId: `model-reasoning-${index + 1}`,
      sequence: index + 1,
      deltas: repeatDelta(delta, 6_000),
    });
  }
  assert.match(snapshot.reasoning!, /^…\[reasoning truncated/u);

  snapshot = testExports.updateSnapshotFromPayload(
    snapshot,
    segmentReset({
      segmentIds: ["model-reasoning-5"],
      keepTextChars: 0,
      dropReasoningChars: 60_000,
    }),
  );
  // The snapshot text was already capped, so its head is gone and no cut from
  // the end can match the runtime: the survivors' blocks are the source. Four
  // whole 60k segments fit under the cap, so the marker is gone and the text
  // is exactly the blocks in order.
  assert.equal(snapshot.reasoning, delta.repeat(6_000 * 4));
  assert.equal(reasoningBlocks(snapshot).length, 4);
  assert.equal(snapshot.reasoningSegments?.length, 4);
});

test("a reset keeps the snapshot reasoning equal to the bounded runtime text when a surviving segment is over the segment cap", () => {
  const run = { runId: "run-1", parentRunId: null, base: "" };
  const delta = "0123456789";
  const survivingText = delta.repeat(7_000); // 70,000 chars > segment cap
  let snapshot: ChatRunSnapshot = { reasoningRun: run, reasoningRevision: 0 };
  snapshot = streamSegment({
    snapshot,
    segmentId: "model-reasoning-A",
    sequence: 1,
    deltas: repeatDelta(delta, 7_000),
  });
  assert.match(
    reasoningBlocks(snapshot)[0]!.text!,
    /^…\[reasoning truncated/u,
    "the surviving block carries the per-segment marker",
  );
  const failedText = "b".repeat(500);
  snapshot = streamSegment({
    snapshot,
    segmentId: "model-reasoning-B",
    sequence: 2,
    phase: "after_tool",
    deltas: repeatDelta("b", 500),
  });
  assert.equal(snapshot.reasoning, `${survivingText}${failedText}`);

  snapshot = testExports.updateSnapshotFromPayload(
    snapshot,
    segmentReset({
      segmentIds: ["model-reasoning-B"],
      keepTextChars: 0,
      dropReasoningChars: failedText.length,
      keepReasoningChars: survivingText.length,
    }),
  );

  // The runtime holds the plain concatenation of what survived; the snapshot
  // must be its snapshot-bounded form, never a join of per-segment blocks.
  assert.equal(snapshot.reasoning, boundSnapshotReasoning(survivingText));
  assert.equal(snapshot.reasoning, survivingText);
  assert.doesNotMatch(snapshot.reasoning!, /reasoning truncated/u);
  assert.equal(reasoningBlocks(snapshot).length, 1);

  // Finalizer (runtime text) and persistTerminalFailure (snapshot text) write
  // the same projection at the terminal revision, so the CAS accepts both.
  const terminalFromRuntime = projectReasoning({
    run,
    text: boundSnapshotReasoning(survivingText),
    terminal: true,
  });
  const terminalFromSnapshot = projectReasoning({
    run,
    text: snapshot.reasoning,
    terminal: true,
  });
  assert.equal(terminalFromRuntime.reasoning, terminalFromSnapshot.reasoning);
  assert.equal(
    canApplyReasoningWrite(terminalFromRuntime, terminalFromSnapshot),
    true,
  );
  assert.equal(
    canApplyReasoningWrite(terminalFromSnapshot, terminalFromRuntime),
    true,
  );
});
