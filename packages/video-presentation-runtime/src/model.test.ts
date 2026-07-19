import assert from "node:assert/strict";
import { test } from "vitest";
import {
  getSlideDurationInFrames,
  getVideoDurationInFrames,
  parseVideoPresentationProject,
} from "./model";
import type { VideoPresentationProjectPayload } from "@sourceweft/contracts/video-presentation";

function payload(input: {
  sceneFrames: number;
  audioSeconds?: number;
}): VideoPresentationProjectPayload {
  return {
    schemaVersion: 2,
    kind: "video_presentation",
    generation: { status: "ready", stage: "ready", progress: 100 },
    project: {
      title: "Model Test",
      fps: 30,
      width: 1920,
      height: 1080,
      durationSeconds: 0,
      stylePreset: "cinematic",
      globalVisualDirection: "Test direction",
    },
    slides: [
      {
        slideNumber: 1,
        title: "Scene One",
        speakerTranscript: ["Hello"],
        sceneIntent: "Show a scene",
        assetRefs: [],
        assetNeeds: [],
      },
    ],
    audioTracks:
      input.audioSeconds === undefined
        ? []
        : [
            {
              slideNumber: 1,
              assetUrl: "/assets/slide-1.mp3",
              storageKey: "slide-1.mp3",
              durationSeconds: input.audioSeconds,
              durationSource: "measured",
              mimeType: "audio/mpeg",
              fileName: "slide-1.mp3",
            },
          ],
    sceneModules: [
      {
        slideNumber: 1,
        title: "Scene One",
        code: "export default function VideoScene() { return null; }",
        componentName: "VideoScene",
        durationInFrames: input.sceneFrames,
        repairAttempts: 0,
        diagnostics: [],
        layoutWarnings: [],
        compileStatus: "compiled",
      },
    ],
    assets: [],
    preview: { slideCount: 1, durationSeconds: 0 },
    renderProfile: {
      stylePreset: "cinematic",
      visualDensity: "balanced",
      durationTarget: "medium",
      language: "auto",
    },
    themeAssignments: [],
    sourceDigest: "digest",
  };
}

test("clamps scene duration up to cover the narration audio", () => {
  // 5s audio at 30fps = 150 frames > declared 90 frames.
  const value = payload({ sceneFrames: 90, audioSeconds: 5 });
  assert.equal(getSlideDurationInFrames(value, 1), 150);
  assert.equal(getVideoDurationInFrames(value), 150);
});

test("keeps the scene duration when it already covers the audio", () => {
  const value = payload({ sceneFrames: 200, audioSeconds: 5 });
  assert.equal(getSlideDurationInFrames(value, 1), 200);
});

test("uses the scene duration untouched when there is no audio track", () => {
  const value = payload({ sceneFrames: 42 });
  assert.equal(getSlideDurationInFrames(value, 1), 42);
});

test("parses legacy payloads without durationSource", () => {
  const legacy = payload({ sceneFrames: 90, audioSeconds: 5 }) as Record<
    string,
    unknown
  > & { audioTracks: Array<Record<string, unknown>> };
  delete legacy.audioTracks[0]?.durationSource;
  const parsed = parseVideoPresentationProject(legacy);
  assert.ok(parsed);
  assert.equal(parsed.audioTracks[0]?.durationSource, "estimated");
});
