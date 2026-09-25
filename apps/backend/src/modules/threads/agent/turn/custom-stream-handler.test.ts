import assert from "node:assert/strict";
import { test } from "vitest";
import { collectCustomStreamEvents } from "../../../../test/turn-stream-collectors";
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
