import assert from "node:assert/strict";
import test from "node:test";
import {
  VIDEO_PRESENTATION_PIPELINE_STAGE_IDS,
  getVideoPresentationPipelineStepLabel,
  videoPresentationGenerationStageSchema,
} from "@sourceweft/contracts/video-presentation";
import {
  VIDEO_PRESENTATION_LABELLED_STAGE_IDS,
  getVideoPresentationStageLabel,
} from "../src/stage-labels";
import { videoPresentationPresentation } from "../src/presentation";

test("every stage the payload can carry has words", () => {
  for (const stage of videoPresentationGenerationStageSchema.options) {
    const label = getVideoPresentationStageLabel(stage);
    assert.ok(label, `stage ${stage} has no label`);
  }
});

test("pipeline stage words are the pipeline table's words, not a copy", () => {
  for (const stage of VIDEO_PRESENTATION_PIPELINE_STAGE_IDS) {
    assert.equal(
      getVideoPresentationStageLabel(stage),
      getVideoPresentationPipelineStepLabel(stage),
      `stage ${stage}`,
    );
  }
});

test("stageStep reports the same words as the stage-label source", () => {
  for (const stage of VIDEO_PRESENTATION_LABELLED_STAGE_IDS) {
    const step = videoPresentationPresentation.stageStep?.({ stageId: stage });
    assert.ok(step, `stage ${stage} produced no step`);
    assert.equal(step.item, getVideoPresentationStageLabel(stage), stage);
  }
});

test("legacy storyboard stage id folds onto its replacement", () => {
  assert.equal(
    getVideoPresentationStageLabel("normalizing_blueprint"),
    getVideoPresentationStageLabel("planning_storyboard"),
  );
});

test("unknown stage ids have no words", () => {
  assert.equal(getVideoPresentationStageLabel("nope"), null);
  assert.equal(getVideoPresentationStageLabel(null), null);
  assert.equal(videoPresentationPresentation.stageStep?.({ stageId: "nope" }), null);
});

test("shared stage vocabulary every client uses is worded", () => {
  for (const stage of ["preparing", "retrying", "generating"]) {
    assert.ok(
      videoPresentationPresentation.stageStep?.({ stageId: stage })?.item,
      `shared stage ${stage} has no words`,
    );
  }
});
