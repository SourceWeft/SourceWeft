import assert from "node:assert/strict";
import test from "node:test";
import { buildVideoPresentationStageView } from "../src/pipeline-digests";
import {
  buildInitialVideoPresentationPipelineSteps,
  videoPresentationProjectPayloadSchema,
} from "@sourceweft/contracts/video-presentation";

function basePayload() {
  return videoPresentationProjectPayloadSchema.parse({
    schemaVersion: 2,
    kind: "video_presentation",
    generation: {
      status: "running",
      stage: "planning_storyboard",
      progress: 10,
      pipelineSteps: buildInitialVideoPresentationPipelineSteps(),
    },
    project: {
      title: "Quarterly Review",
      fps: 30,
      width: 1920,
      height: 1080,
      durationSeconds: 0,
      stylePreset: "cinematic",
      globalVisualDirection: "Clean executive deck",
    },
    slides: [
      {
        slideNumber: 1,
        title: "Agenda",
        subtitle: "What we will cover",
        speakerTranscript: ["Welcome everyone"],
        sceneIntent: "Intro",
        assetRefs: [],
      },
      {
        slideNumber: 2,
        title: "Results",
        speakerTranscript: ["Here are the numbers"],
        sceneIntent: "Charts",
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

test("storyboard stage view includes slide titles in display", () => {
  const view = buildVideoPresentationStageView(
    "planning_storyboard",
    basePayload(),
  );
  assert.match(view.summary ?? "", /2 slides/);
  assert.match(view.display ?? "", /Agenda/);
  assert.match(view.display ?? "", /Results/);
  assert.match(view.display ?? "", /Quarterly Review/);
});

test("theme stage view lists assignments", () => {
  const payload = videoPresentationProjectPayloadSchema.parse({
    ...basePayload(),
    themeAssignments: [
      {
        slideNumber: 1,
        themeName: "Midnight",
        mode: "dark",
      },
      {
        slideNumber: 2,
        themeName: "Sunrise",
        mode: "light",
      },
    ],
  });
  const view = buildVideoPresentationStageView("assigning_slide_themes", payload);
  assert.match(view.display ?? "", /Midnight/);
  assert.match(view.display ?? "", /Sunrise/);
  assert.equal(view.metrics?.assignmentCount, 2);
});
