import assert from "node:assert/strict";
import { test } from "vitest";
import { createVideoPresentationPipelineDefinition } from "@sourceweft/builtin-tool-video-presentation";
import {
  buildInitialVideoPresentationPipelineSteps,
  videoPresentationProjectPayloadSchema,
  type VideoPresentationProjectPayload,
} from "@sourceweft/contracts/video-presentation";
import type { ArtifactPipelineStep } from "@sourceweft/contracts/artifact-pipeline";
import {
  createDeliverableStageRunner,
  runStageWithBudget,
  type AdvanceDeliverableStepInput,
} from "./stage-runner";

// The generic stage runner bound to the real video pipeline definition —
// same binding the host uses in production.
const definition = createVideoPresentationPipelineDefinition();
const runner = createDeliverableStageRunner({
  stages: definition.stages,
  computeOverallProgress: definition.computeOverallProgress as (
    steps: readonly ArtifactPipelineStep[],
  ) => number,
});

function advancePipelineStep(
  payload: VideoPresentationProjectPayload,
  input: AdvanceDeliverableStepInput,
) {
  return runner.advanceStep(payload, input);
}

function markPipelineFailed(
  payload: VideoPresentationProjectPayload,
  input: { errorCode: string; errorMessage: string },
) {
  return runner.markFailed(payload, input);
}

function basePayload() {
  return videoPresentationProjectPayloadSchema.parse({
    schemaVersion: 2,
    kind: "video_presentation",
    generation: {
      status: "pending",
      stage: "planning_storyboard",
      progress: 0,
      pipelineSteps: buildInitialVideoPresentationPipelineSteps(),
    },
    project: {
      title: "Demo",
      fps: 30,
      width: 1920,
      height: 1080,
      durationSeconds: 0,
      stylePreset: "cinematic",
      globalVisualDirection: "demo",
    },
    slides: [
      {
        slideNumber: 1,
        title: "Demo",
        speakerTranscript: ["Hello"],
        sceneIntent: "Intro",
        assetRefs: [],
      },
    ],
    renderProfile: {
      stylePreset: "cinematic",
      visualDensity: "balanced",
      durationTarget: "medium",
      language: "auto",
    },
    sourceDigest: "demo",
  });
}

test("advancePipelineStep marks running and completed stages", () => {
  let payload = basePayload();
  payload = advancePipelineStep(payload, {
    action: "start",
    stageId: "planning_storyboard",
    maxAttempts: 2,
  });
  const running = payload.generation.pipelineSteps?.find(
    (step) => step.id === "planning_storyboard",
  );
  assert.equal(running?.status, "running");
  assert.equal(running?.maxAttempts, 2);

  payload = advancePipelineStep(payload, {
    action: "complete",
    stageId: "planning_storyboard",
  });
  const completed = payload.generation.pipelineSteps?.find(
    (step) => step.id === "planning_storyboard",
  );
  assert.equal(completed?.status, "completed");
  assert.equal(payload.generation.checkpointStage, "planning_storyboard");
});

test("advancePipelineStep persists stage display and mid-progress", () => {
  let payload = basePayload();
  payload = advancePipelineStep(payload, {
    action: "start",
    stageId: "planning_storyboard",
  });
  payload = advancePipelineStep(payload, {
    action: "progress",
    stageId: "planning_storyboard",
    summary: "Drafting slides",
    display: "# Storyboard\n\n1. **Demo**",
    stepProgress: 40,
    logTail: ["planning…"],
  });
  const mid = payload.generation.pipelineSteps?.find(
    (step) => step.id === "planning_storyboard",
  );
  assert.equal(mid?.status, "running");
  assert.equal(mid?.progress, 40);
  assert.equal(mid?.summary, "Drafting slides");
  assert.match(mid?.display ?? "", /Demo/);

  payload = advancePipelineStep(payload, {
    action: "complete",
    stageId: "planning_storyboard",
    summary: "Planned 1 slides · Demo",
    display: "# Storyboard · Demo\n\n1. **Demo** — Hello",
    metrics: { slideCount: 1 },
  });
  const done = payload.generation.pipelineSteps?.find(
    (step) => step.id === "planning_storyboard",
  );
  assert.equal(done?.status, "completed");
  assert.equal(done?.progress, 100);
  assert.match(done?.display ?? "", /Hello/);
  assert.equal(done?.metrics?.slideCount, 1);
});

test("runStageWithBudget retries failed stage without touching completed steps", async () => {
  let attempts = 0;
  await runStageWithBudget({
    stageId: "assigning_slide_themes",
    config: { budgetMs: 5_000, maxAttempts: 2 },
    fn: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary failure");
      }
    },
  });
  assert.equal(attempts, 2);
});

test("markPipelineFailed preserves completed pipeline steps", () => {
  let payload = basePayload();
  payload = advancePipelineStep(payload, {
    action: "start",
    stageId: "planning_storyboard",
  });
  payload = advancePipelineStep(payload, {
    action: "complete",
    stageId: "planning_storyboard",
  });
  payload = advancePipelineStep(payload, {
    action: "start",
    stageId: "materializing_assets",
  });
  payload = markPipelineFailed(payload, {
    errorCode: "VIDEO_PRESENTATION_GENERATION_FAILED",
    errorMessage: "Storyboard failed",
  });

  const storyboard = payload.generation.pipelineSteps?.find(
    (step) => step.id === "planning_storyboard",
  );
  const materializing = payload.generation.pipelineSteps?.find(
    (step) => step.id === "materializing_assets",
  );
  assert.equal(storyboard?.status, "completed");
  assert.equal(materializing?.status, "failed");
  assert.equal(payload.generation.status, "failed");
  assert.equal(payload.generation.checkpointStage, "materializing_assets");
});

test("markPipelineFailed marks next pending step when none are running", () => {
  let payload = basePayload();
  payload = advancePipelineStep(payload, {
    action: "start",
    stageId: "planning_storyboard",
  });
  payload = advancePipelineStep(payload, {
    action: "complete",
    stageId: "planning_storyboard",
  });
  payload = markPipelineFailed(payload, {
    errorCode: "VIDEO_PRESENTATION_SANDBOX_EXECUTION_FAILED",
    errorMessage: "Sandbox failed between stages",
  });

  const materializing = payload.generation.pipelineSteps?.find(
    (step) => step.id === "materializing_assets",
  );
  assert.equal(materializing?.status, "failed");
  assert.equal(payload.generation.checkpointStage, "materializing_assets");
});
