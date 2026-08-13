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

test("clamps scene duration up to cover the narration audio plus the tail pad", () => {
  // 5s audio + 0.75s tail pad at 30fps = ceil(5.75 * 30) = 173 frames, above
  // the declared 90. The runtime must re-add the pad, not floor at the raw
  // 150-frame audio length — the pad is what keeps the speech tail from being
  // clipped at the <Sequence> boundary.
  const value = payload({ sceneFrames: 90, audioSeconds: 5 });
  assert.equal(getSlideDurationInFrames(value, 1), 173);
  assert.equal(getVideoDurationInFrames(value), 173);
});

test("still applies the tail pad when the scene module is only slightly short", () => {
  // 160 already exceeds the raw 150-frame audio length, so a pad-less floor
  // would leave it untouched and drop the buffer. It must still be lifted to
  // the padded 173.
  const value = payload({ sceneFrames: 160, audioSeconds: 5 });
  assert.equal(getSlideDurationInFrames(value, 1), 173);
});

test("keeps the scene duration when it already covers the audio and pad", () => {
  const value = payload({ sceneFrames: 200, audioSeconds: 5 });
  assert.equal(getSlideDurationInFrames(value, 1), 200);
});

test("uses the scene duration untouched when there is no audio track", () => {
  const value = payload({ sceneFrames: 42 });
  assert.equal(getSlideDurationInFrames(value, 1), 42);
});

test("parses payloads that still carry the retired durationSource field", () => {
  // Every persisted payload written before durations became measurement-only
  // has `durationSource` on its tracks. The schema is not strict, so the field
  // is dropped on parse rather than rejecting an artifact that is otherwise
  // perfectly playable — the timeline never read it, only `durationSeconds`.
  const legacy = payload({ sceneFrames: 90, audioSeconds: 5 }) as Record<
    string,
    unknown
  > & { audioTracks: Array<Record<string, unknown>> };
  legacy.audioTracks[0]!.durationSource = "estimated";
  const parsed = parseVideoPresentationProject(legacy);
  assert.ok(parsed);
  assert.equal(parsed.audioTracks[0]?.durationSeconds, 5);
  assert.equal("durationSource" in parsed.audioTracks[0]!, false);
});
