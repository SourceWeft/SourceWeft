import assert from "node:assert/strict";
import { test } from "vitest";
import {
  normalizeGeneratedImageProgressEvent,
  normalizeGeneratedPresentationProgressEvent,
} from "./progress-events";
import { testExports } from "./runner";

test("presentation publishing trace step stays active before tool execution", () => {
  const step = testExports.buildArtifactGenerationStep({
    phase: "planning",
    toolName: "publish_artifact",
  });

  assert.ok(step);
  assert.equal(step.id, "presentation-generation");
  assert.equal(step.title, "Publishing presentation");
  assert.equal(step.status, "in_progress");
  assert.equal(step.metadata?.phase, "planning");
});

test("presentation publishing trace step records completed artifacts", () => {
  const step = testExports.buildArtifactGenerationStep({
    latencyMs: 1234,
    phase: "completed",
    toolCallId: "call-1",
    toolName: "publish_artifact",
  });

  assert.ok(step);
  assert.equal(step.title, "Published presentation");
  assert.equal(step.status, "completed");
  assert.deepEqual(step.items, ["Presentation artifact created"]);
  assert.equal(step.metadata?.toolCallId, "call-1");
  assert.equal(step.metadata?.latencyMs, 1234);
});

test("presentation publishing trace step records needs_content repair state", () => {
  const step = testExports.buildArtifactGenerationStep({
    phase: "repairing",
    toolCallId: "call-1",
    toolName: "publish_artifact",
  });

  assert.ok(step);
  assert.equal(step.title, "Publishing presentation");
  assert.equal(step.status, "in_progress");
  assert.deepEqual(step.items, ["Adding explicit slide content"]);
  assert.equal(
    step.description,
    "The deck tool needs a complete deck plan before artifact creation.",
  );
  assert.equal(step.metadata?.phase, "repairing");
});

test("presentation progress events map to CoT-safe publishing steps", () => {
  const planning = testExports.buildPresentationProgressThinkingStep({
    data: {
      type: "publish_artifact_progress",
      tool: "publish_artifact",
      toolCallId: "call-1",
      stage: "planning",
      title: "Launch deck",
    },
    toolCallId: "call-1",
  });
  const generating = testExports.buildPresentationProgressThinkingStep({
    data: {
      type: "publish_artifact_progress",
      tool: "publish_artifact",
      toolCallId: "call-1",
      stage: "generating",
      slideCount: 8,
    },
    toolCallId: "call-1",
  });
  const saving = testExports.buildPresentationProgressThinkingStep({
    data: {
      type: "publish_artifact_progress",
      tool: "publish_artifact",
      toolCallId: "call-1",
      stage: "saving",
      fileName: "launch-deck.html",
    },
    toolCallId: "call-1",
  });
  const ready = testExports.buildPresentationProgressThinkingStep({
    data: {
      type: "publish_artifact_progress",
      tool: "publish_artifact",
      toolCallId: "call-1",
      stage: "ready",
      artifactId: "artifact-1",
    },
    toolCallId: "call-1",
  });

  assert.equal(planning?.id, "presentation-generation");
  assert.equal(planning?.title, "Publishing presentation");
  assert.equal(planning?.status, "in_progress");
  assert.deepEqual(planning?.items, ["Preparing presentation artifact"]);
  assert.deepEqual(generating?.items, ["Validating generated PPTX"]);
  assert.equal(generating?.status, "in_progress");
  assert.deepEqual(saving?.items, ["Publishing presentation artifact"]);
  assert.equal(saving?.status, "in_progress");
  assert.equal(ready?.title, "Published presentation");
  assert.equal(ready?.status, "completed");
  assert.deepEqual(ready?.items, ["Presentation artifact created"]);
  assert.equal(ready?.metadata?.toolCallId, "call-1");
});

test("unknown presentation progress stages do not create CoT steps", () => {
  assert.equal(
    testExports.buildPresentationProgressThinkingStep({
      data: {
        type: "publish_artifact_progress",
        tool: "publish_artifact",
        toolCallId: "call-1",
        stage: "internal_layout_pass",
      },
      toolCallId: "call-1",
    }),
    null,
  );
});

test("presentation progress emits tool event before CoT step", () => {
  const sequence: number[] = [];
  const progressEvent = normalizeGeneratedPresentationProgressEvent({
    type: "publish_artifact_progress",
    toolCallId: "call-1",
    stage: "saving",
  });
  assert.ok(progressEvent);
  const thinkingEvent = testExports.buildPresentationProgressThinkingEvent({
    progressEvent,
    setThinkingStep: (step) => ({
      ...step,
      sequence: sequence.push(sequence.length + 1),
    }),
  });
  assert.ok(thinkingEvent);

  const events = [
    {
      type: "tool-call-event" as const,
      id: progressEvent.toolCallId,
      tool: progressEvent.tool,
      data: progressEvent.data,
      toolCall: {
        id: progressEvent.toolCallId,
        tool: progressEvent.tool,
        input: {},
        output: progressEvent.data,
        status: "running" as const,
        latencyMs: null,
        error: null,
      },
    },
    thinkingEvent,
  ];

  assert.deepEqual(
    events.map((event) => event.type),
    ["tool-call-event", "thinking-step"],
  );
  const stepEvent = events[1];
  assert.equal(stepEvent?.type, "thinking-step");
  assert.deepEqual(
    stepEvent?.type === "thinking-step" ? stepEvent.step.items : [],
    ["Publishing presentation artifact"],
  );
});

test("normalizes generated image custom progress events", () => {
  assert.deepEqual(
    normalizeGeneratedImageProgressEvent({
      type: "generate_image_progress",
      toolCallId: "tool-1",
      tool: "web_search",
      stage: "generating",
    }),
    {
      toolCallId: "tool-1",
      tool: "generate_image",
      data: {
        type: "generate_image_progress",
        toolCallId: "tool-1",
        tool: "generate_image",
        stage: "generating",
      },
    },
  );

  assert.equal(
    normalizeGeneratedImageProgressEvent({
      type: "other_event",
      toolCallId: "tool-1",
    }),
    null,
  );
});
