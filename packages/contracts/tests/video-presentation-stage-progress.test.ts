import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VIDEO_PRESENTATION_PIPELINE_STAGE_IDS,
  VIDEO_PRESENTATION_STAGE_PROGRESS,
  resolveVideoPresentationPipelineStageProgress,
  videoPresentationGenerationStageSchema,
} from "../src/video-presentation";

test("stage progress covers every generation stage", () => {
  // The worker indexes this table by VideoPresentationGenerationStage, so a
  // missing entry surfaces as an undefined progress value at runtime.
  for (const stage of videoPresentationGenerationStageSchema.options) {
    assert.equal(
      typeof VIDEO_PRESENTATION_STAGE_PROGRESS[stage],
      "number",
      `missing progress for stage '${stage}'`,
    );
  }
});

test("pipeline helper reads from the shared stage table", () => {
  for (const stageId of VIDEO_PRESENTATION_PIPELINE_STAGE_IDS) {
    assert.equal(
      resolveVideoPresentationPipelineStageProgress(stageId),
      VIDEO_PRESENTATION_STAGE_PROGRESS[stageId],
      `progress mismatch for '${stageId}'`,
    );
  }
});

test("progress increases monotonically along the pipeline order", () => {
  const values = VIDEO_PRESENTATION_PIPELINE_STAGE_IDS.map(
    (id) => VIDEO_PRESENTATION_STAGE_PROGRESS[id],
  );
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(
      values[i]! > values[i - 1]!,
      `progress must increase at '${VIDEO_PRESENTATION_PIPELINE_STAGE_IDS[i]}': ${values[i - 1]} -> ${values[i]}`,
    );
  }
});

test("terminal stages report full progress, pipeline stages stay below it", () => {
  assert.equal(VIDEO_PRESENTATION_STAGE_PROGRESS.ready, 100);
  assert.equal(VIDEO_PRESENTATION_STAGE_PROGRESS.failed, 100);
  // A pipeline stage at 100 would render as finished while work is still running.
  for (const stageId of VIDEO_PRESENTATION_PIPELINE_STAGE_IDS) {
    assert.ok(
      VIDEO_PRESENTATION_STAGE_PROGRESS[stageId] < 100,
      `pipeline stage '${stageId}' must stay below the terminal 100`,
    );
  }
});

test("every pipeline stage id is also a generation stage", () => {
  // Guards the two enums drifting apart: a pipeline id with no matching
  // generation stage would break normalizeWorkerStageToPipelineStage.
  const generationStages = new Set<string>(
    videoPresentationGenerationStageSchema.options,
  );
  for (const stageId of VIDEO_PRESENTATION_PIPELINE_STAGE_IDS) {
    assert.ok(
      generationStages.has(stageId),
      `pipeline stage '${stageId}' is not a generation stage`,
    );
  }
});
