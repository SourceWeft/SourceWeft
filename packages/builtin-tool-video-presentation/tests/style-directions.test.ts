import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInitialVideoPresentationPipelineSteps,
  videoPresentationProjectPayloadSchema,
  videoPresentationThemeAssignmentSchema,
} from "@sourceweft/contracts/video-presentation";
import { buildSceneUserPrompt } from "../src/pipeline/scene-gen";
import { VIDEO_STYLE_PRESET_DIRECTIONS } from "../src/pipeline/style-directions";

const STYLE_PRESETS = [
  "cinematic",
  "editorial",
  "executive",
  "technical",
  "product",
] as const;

function stylePayload(projectExtras: Record<string, unknown> = {}) {
  return videoPresentationProjectPayloadSchema.parse({
    schemaVersion: 2,
    kind: "video_presentation",
    generation: {
      status: "running",
      stage: "generating_scene_modules",
      progress: 50,
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
      ...projectExtras,
    },
    slides: [
      {
        slideNumber: 1,
        title: "Agenda",
        speakerTranscript: ["Welcome everyone"],
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

const theme = videoPresentationThemeAssignmentSchema.parse({
  slideNumber: 1,
  themeName: "Midnight",
  mode: "dark",
});

test("style preset directions cover all five presets with substantial, distinct guidance", () => {
  assert.deepEqual(
    Object.keys(VIDEO_STYLE_PRESET_DIRECTIONS).sort(),
    [...STYLE_PRESETS].sort(),
  );
  for (const preset of STYLE_PRESETS) {
    assert.ok(
      VIDEO_STYLE_PRESET_DIRECTIONS[preset].length >= 120,
      `${preset} direction should be at least 120 chars`,
    );
  }
  const uniqueDirections = new Set(Object.values(VIDEO_STYLE_PRESET_DIRECTIONS));
  assert.equal(
    uniqueDirections.size,
    STYLE_PRESETS.length,
    "each preset direction must be distinct",
  );
});

test("buildSceneUserPrompt injects style direction, brand palette, and motion", () => {
  const payload = stylePayload({
    brand: {
      colors: ["#0B1D3A", "#F5B301"],
      typography: "Inter, semi-bold headlines",
    },
    motion: {
      pacing: "calm",
      transitionStyle: "crossfade",
      animationIntensity: "subtle",
    },
  });
  const [slide] = payload.slides;
  assert.ok(slide);
  const prompt = buildSceneUserPrompt({ payload, slide, theme });
  assert.ok(prompt.includes("Style preset direction (cinematic):"));
  assert.ok(prompt.includes(VIDEO_STYLE_PRESET_DIRECTIONS.cinematic));
  assert.ok(
    prompt.includes(
      "Brand palette (MUST take priority over the theme's colors): #0B1D3A, #F5B301",
    ),
  );
  assert.ok(prompt.includes("Brand typography: Inter, semi-bold headlines"));
  assert.ok(
    prompt.includes(
      "Motion: pacing=calm, intensity=subtle, transitions=crossfade",
    ),
  );
});

test("buildSceneUserPrompt omits brand and motion lines when absent", () => {
  const payload = stylePayload();
  const [slide] = payload.slides;
  assert.ok(slide);
  const prompt = buildSceneUserPrompt({ payload, slide, theme });
  assert.ok(prompt.includes("Style preset direction (cinematic):"));
  assert.ok(!prompt.includes("Brand palette"));
  assert.ok(!prompt.includes("Brand typography"));
  assert.ok(!prompt.includes("Motion:"));
  assert.ok(!prompt.includes("undefined"));
});
