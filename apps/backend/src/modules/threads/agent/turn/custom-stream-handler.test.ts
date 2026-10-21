import assert from "node:assert/strict";
import { test } from "vitest";
import { collectCustomStreamEvents } from "../../../../test/turn-stream-collectors";
import { handleToolArgDeltaChunk } from "./tool-arg-stream-handler";
import { createTurnRuntime } from "./turn-runtime";

test("custom stream handler emits generated artifact progress events", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-custom-progress",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
  runtime.toolCallsById.set("image-call", {
    id: "image-call",
    tool: "generate_image",
    input: {},
    output: null,
    status: "running",
    latencyMs: null,
    error: null,
    sequence: 1,
  });
  runtime.toolCallsById.set("pptx-call", {
    id: "pptx-call",
    tool: "publish_artifact",
    input: {},
    output: null,
    status: "running",
    latencyMs: null,
    error: null,
    sequence: 2,
  });

  const imageEvents = await collectCustomStreamEvents({
    payload: {
      type: "generate_image_progress",
      toolCallId: "image-call",
      tool: "ignored_tool_name",
      stage: "generating",
    },
    runtime,
  });
  const pptxEvents = await collectCustomStreamEvents({
    payload: {
      type: "publish_artifact_progress",
      tool: "publish_artifact",
      toolCallId: "pptx-call",
      stage: "saving",
    },
    runtime,
  });

  assert.deepEqual(
    imageEvents.map((event) => event.type),
    ["tool-call-event"],
  );
  assert.deepEqual(
    pptxEvents.map((event) => event.type),
    ["tool-call-event", "thinking-step"],
  );
  assert.equal(imageEvents[0]?.type, "tool-call-event");
  assert.equal(
    imageEvents[0]?.type === "tool-call-event" ? imageEvents[0].tool : null,
    "generate_image",
  );
  assert.equal(pptxEvents[0]?.type, "tool-call-event");
  assert.equal(
    pptxEvents[0]?.type === "tool-call-event" ? pptxEvents[0].tool : null,
    "publish_artifact",
  );
  assert.equal(pptxEvents[1]?.type, "thinking-step");
  assert.deepEqual(
    pptxEvents[1]?.type === "thinking-step" ? pptxEvents[1].step.items : [],
    ["Publishing presentation artifact"],
  );
  assert.equal(
    runtime.toolCallsById.get("pptx-call")?.output,
    pptxEvents[0]?.type === "tool-call-event" ? pptxEvents[0].data : null,
  );
});

test("custom stream handler ignores unknown custom payloads", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-unknown-custom-progress",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
  runtime.toolCallsById.set("known-call", {
    id: "known-call",
    tool: "generate_image",
    input: {},
    output: null,
    status: "running",
    latencyMs: null,
    error: null,
    sequence: 1,
  });

  const events = await collectCustomStreamEvents({
    payload: {
      type: "unrelated_custom_event",
      toolCallId: "known-call",
      stage: "generating",
    },
    runtime,
  });

  assert.deepEqual(events, []);
  assert.deepEqual(runtime.toolCallsById.get("known-call"), {
    id: "known-call",
    tool: "generate_image",
    input: {},
    output: null,
    status: "running",
    latencyMs: null,
    error: null,
    sequence: 1,
  });
});

test("budget phase progress is validated and monotonic without creating a stop", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "budget-progress",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
  const closing = {
    policyVersion: 2,
    phase: "closing",
    normalSteps: 400,
    normalLimit: 400,
    closingSteps: 1,
    closingLimit: 40,
    steps: 401,
    limit: 440,
  } as const;
  const events = await collectCustomStreamEvents({
    payload: { type: "agent-run-progress", progress: closing },
    runtime,
  });
  assert.deepEqual(events, [{ type: "agent-run-progress", progress: closing }]);
  assert.deepEqual(runtime.agentRunProgress, closing);
  assert.equal(runtime.agentRunStop, undefined);
  for (const progress of [
    closing,
    { ...closing, phase: "working", closingSteps: 0, steps: 400 },
    { ...closing, privateScope: "secret" },
    { ...closing, closingLimit: 80, limit: 480 },
  ]) {
    assert.deepEqual(
      await collectCustomStreamEvents({
        payload: { type: "agent-run-progress", progress },
        runtime,
      }),
      [],
    );
  }
  assert.deepEqual(runtime.agentRunProgress, closing);
});

test("model-call-begin marks the boundary and model-call-retry withdraws the attempt as one segment-reset", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-retry-reset",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });

  assert.deepEqual(
    await collectCustomStreamEvents({
      payload: { type: "model-call-begin", attempt: 1 },
      runtime,
    }),
    [],
  );
  assert.equal(runtime.modelCallBoundary?.attempt, 1);

  runtime.modelReasoning = "partial";
  const segment = runtime.appendReasoningSegment("partial");
  runtime.renderBlocks.appendReasoning({ id: segment.id, text: "partial" });
  runtime.assistantContent = "Half";
  runtime.renderBlocks.appendText("Half");
  runtime.hasStreamedText = true;
  runtime.partialToolArgsBySlot.set("0", {
    id: "call-1",
    name: "write_file",
    args: '{"content":"a',
    lastContentLength: 1,
  });

  const events = await collectCustomStreamEvents({
    payload: {
      type: "model-call-retry",
      attempt: 2,
      errorCode: "MODEL_TIMEOUT",
    },
    runtime,
  });
  assert.deepEqual(events, [
    {
      type: "segment-reset",
      reason: "model_call_retry",
      attempt: 2,
      segmentIds: [segment.id],
      toolCallIds: ["call-1"],
      keepTextChars: 0,
      keepReasoningChars: 0,
      dropTextChars: "Half".length,
      dropReasoningChars: "partial".length,
    },
  ]);
  assert.equal(runtime.modelCallBoundary, null);
  assert.equal(runtime.assistantContent, "");
  assert.equal(runtime.modelReasoning, undefined);
  assert.deepEqual(runtime.reasoningSegments, []);
  assert.deepEqual(runtime.renderBlocks.list(), []);
  assert.equal(runtime.partialToolArgsBySlot.size, 0);
  assert.equal(runtime.currentReasoningSegment, null);
  // The retried attempt's segment takes a fresh id.
  assert.notEqual(runtime.appendReasoningSegment("again").id, segment.id);
});

test("model-call-retry without a preceding model-call-begin emits nothing", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-retry-no-begin",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
  runtime.assistantContent = "kept";
  const events = await collectCustomStreamEvents({
    payload: {
      type: "model-call-retry",
      attempt: 2,
      errorCode: "MODEL_TIMEOUT",
    },
    runtime,
  });
  assert.deepEqual(events, []);
  assert.equal(runtime.assistantContent, "kept");
});

test("model-call-begin closes a segment left open by a model re-entry, so the retry withdraws by id", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-reenter",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
  await collectCustomStreamEvents({
    payload: { type: "model-call-begin", attempt: 1 },
    runtime,
  });
  runtime.modelReasoning = "first";
  const first = runtime.appendReasoningSegment("first");
  runtime.renderBlocks.appendReasoning({ id: first.id, text: "first" });

  // No tool boundary before the next call (step-budget `jumpTo: "model"`).
  await collectCustomStreamEvents({
    payload: { type: "model-call-begin", attempt: 1 },
    runtime,
  });
  assert.equal(runtime.currentReasoningSegment, null);
  runtime.modelReasoning = "first" + "second";
  const second = runtime.appendReasoningSegment("second");
  runtime.renderBlocks.appendReasoning({ id: second.id, text: "second" });
  assert.notEqual(second.id, first.id);

  const events = await collectCustomStreamEvents({
    payload: {
      type: "model-call-retry",
      attempt: 2,
      errorCode: "MODEL_TIMEOUT",
    },
    runtime,
  });
  assert.deepEqual(events, [
    {
      type: "segment-reset",
      reason: "model_call_retry",
      attempt: 2,
      segmentIds: [second.id],
      toolCallIds: [],
      keepTextChars: 0,
      keepReasoningChars: "first".length,
      dropTextChars: 0,
      dropReasoningChars: "second".length,
    },
  ]);
  assert.deepEqual(
    runtime.reasoningSegments.map((segment) => [segment.id, segment.text]),
    [[first.id, "first"]],
  );
  assert.equal(runtime.modelReasoning, "first");
  assert.deepEqual(
    runtime.renderBlocks.list().map((block) => block.id),
    [first.id],
  );
});

test("model-call-begin drops an earlier call's tool-arg slots, so a retry names the new call", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-slot-reuse",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
  // A completed earlier call left a long buffer in block slot 0, and its tool
  // call was promoted by the `tools` method.
  await collectCustomStreamEvents({
    payload: { type: "model-call-begin", attempt: 1 },
    runtime,
  });
  [
    ...handleToolArgDeltaChunk({
      delta: {
        index: 0,
        id: "old-call",
        name: "write_file",
        args: '{"path":"/a.ts","content":"a long finished file"}',
      },
      runtime,
    }),
  ];
  runtime.toolCallsById.set("old-call", {
    id: "old-call",
    tool: "write_file",
    input: {},
    output: null,
    status: "completed",
    latencyMs: null,
    error: null,
    sequence: 1,
  });

  // The next call reuses slot 0 with a shorter (cumulative) buffer, then fails.
  await collectCustomStreamEvents({
    payload: { type: "model-call-begin", attempt: 1 },
    runtime,
  });
  assert.equal(runtime.partialToolArgsBySlot.size, 0);
  const deltas = [
    ...handleToolArgDeltaChunk({
      delta: {
        index: 0,
        id: "new-call",
        name: "write_file",
        args: '{"content":"x',
      },
      runtime,
    }),
  ];
  assert.deepEqual(
    deltas.map((event) => event.type === "tool-input-delta" && event.id),
    ["new-call"],
  );

  const events = await collectCustomStreamEvents({
    payload: {
      type: "model-call-retry",
      attempt: 2,
      errorCode: "MODEL_TIMEOUT",
    },
    runtime,
  });
  assert.deepEqual(
    events.map((event) => event.type === "segment-reset" && event.toolCallIds),
    [["new-call"]],
  );
  assert.equal(runtime.partialToolArgsBySlot.size, 0);
});
