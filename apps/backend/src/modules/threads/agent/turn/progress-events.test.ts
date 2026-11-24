import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildArtifactGenerationStep,
  buildPresentationProgressThinkingEvent,
  buildPresentationProgressThinkingStep,
  normalizeGeneratedImageProgressEvent,
  normalizeGeneratedPresentationProgressEvent,
} from "./progress-events";

test("presentation publishing trace step stays active before tool execution", () => {
  const step = buildArtifactGenerationStep({
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
  const step = buildArtifactGenerationStep({
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
  const step = buildArtifactGenerationStep({
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
  const planning = buildPresentationProgressThinkingStep({
    data: {
      type: "publish_artifact_progress",
      tool: "publish_artifact",
      toolCallId: "call-1",
      stage: "planning",
      title: "Launch deck",
    },
    toolCallId: "call-1",
  });
  const generating = buildPresentationProgressThinkingStep({
    data: {
      type: "publish_artifact_progress",
      tool: "publish_artifact",
      toolCallId: "call-1",
      stage: "generating",
      slideCount: 8,
    },
    toolCallId: "call-1",
  });
  const saving = buildPresentationProgressThinkingStep({
    data: {
      type: "publish_artifact_progress",
      tool: "publish_artifact",
      toolCallId: "call-1",
      stage: "saving",
      fileName: "launch-deck.html",
    },
    toolCallId: "call-1",
  });
  const ready = buildPresentationProgressThinkingStep({
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
    buildPresentationProgressThinkingStep({
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
  const thinkingEvent = buildPresentationProgressThinkingEvent({
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

test("video validation progress becomes a replaceable validation step", () => {
  const start = buildArtifactGenerationStep({
    phase: "generating",
    toolCallId: "call-v",
    toolName: "validate_video_presentation",
  });
  assert.ok(start);
  assert.equal(start.id, "video-validation");
  assert.equal(start.status, "in_progress");

  const event = normalizeGeneratedPresentationProgressEvent({
    type: "validate_video_presentation_progress",
    tool: "validate_video_presentation",
    toolCallId: "call-v",
    stage: "install",
  });
  assert.ok(event);
  assert.equal(event.tool, "validate_video_presentation");
  assert.equal(event.toolCallId, "call-v");

  const installing = buildPresentationProgressThinkingStep({
    data: event.data,
    toolCallId: "call-v",
  });
  const rendering = buildPresentationProgressThinkingStep({
    data: { ...event.data, stage: "render" },
    toolCallId: "call-v",
  });
  assert.ok(installing);
  assert.ok(rendering);
  // One stable id, so each stage replaces the previous item instead of
  // appending a new step to the turn.
  assert.equal(installing.id, "video-validation");
  assert.equal(rendering.id, installing.id);
  assert.equal(installing.status, "in_progress");
  assert.deepEqual(installing.items, ["Installing project dependencies"]);
  assert.deepEqual(rendering.items, ["Rendering the final video"]);
  assert.equal(installing.metadata?.toolCallId, "call-v");
});

test("video validation closes its step on the validation verdict", () => {
  const passed = buildArtifactGenerationStep({
    phase: "completed",
    toolCallId: "call-v",
    toolName: "validate_video_presentation",
  });
  const failed = buildArtifactGenerationStep({
    error: "VIDEO_PROJECT_VALIDATION_FAILED",
    phase: "failed",
    toolCallId: "call-v",
    toolName: "validate_video_presentation",
  });
  assert.equal(passed?.status, "completed");
  assert.equal(passed?.title, "Video presentation validated");
  assert.equal(failed?.status, "completed");
  assert.equal(failed?.title, "Video presentation validation failed");
  assert.equal(failed?.description, "VIDEO_PROJECT_VALIDATION_FAILED");
});

test("a progress event type no capability declares is not routed", () => {
  assert.equal(
    normalizeGeneratedPresentationProgressEvent({
      type: "validate_video_unknown_progress",
      toolCallId: "call-v",
      stage: "install",
    }),
    null,
  );
});
