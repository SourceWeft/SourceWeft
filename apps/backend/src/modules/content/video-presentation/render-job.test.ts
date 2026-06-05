import assert from "node:assert/strict";
import { test } from "vitest";
import { testExports } from "./render-job";
import type { RenderableVideoPresentationSpec } from "./spec";

const spec: RenderableVideoPresentationSpec = {
  schemaVersion: 1,
  title: "Launch plan",
  fps: 30,
  width: 1920,
  height: 1080,
  narrationEnabled: true,
  theme: {
    background: "#0b1017",
    foreground: "#f8fafc",
    accent: "#38bdf8",
    secondary: "#f59e0b",
    muted: "#94a3b8",
    fontFamily: "Inter, sans-serif",
  },
  slides: [
    {
      slideNumber: 1,
      title: "Launch plan",
      speakerTranscript: ["We will launch in three focused phases."],
    },
  ],
  scenes: [
    {
      slideNumber: 1,
      sceneType: "title",
      composition: "cinematic",
      mood: "executive",
      title: "Launch plan",
      bullets: [],
      metrics: [],
      timeline: [],
      motion: {
        camera: "slow-push",
        emphasis: "spotlight",
        entrance: "rise",
        transition: "fade",
      },
    },
  ],
  audioTracks: [
    {
      assetUrl: "/v1/workspaces/workspace-1/artifacts/artifact-1/assets/narration-slide-01.mp3",
      durationSeconds: 5,
      fileName: "narration-slide-01.mp3",
      mimeType: "audio/mpeg",
      renderSrc: "data:audio/mpeg;base64,abc",
      slideNumber: 1,
      storageBucket: "bucket",
      storageKey: "audio-key",
    },
  ],
};

test("video presentation project manifest strips render-only audio fields", () => {
  const manifest = testExports.buildProjectManifest({
    spec,
    fileName: "launch.video-presentation.json",
    title: "Launch plan",
  });

  assert.equal(manifest.renderStrategy, "frontend_remotion_project_to_video");
  assert.equal(manifest.videoDownloadOnly, true);
  assert.equal(manifest.fileName, "launch.video-presentation.json");
  assert.equal(
    manifest.mimeType,
    "application/vnd.sourceweft.video-presentation+json",
  );
  assert.equal(manifest.audioTracks[0]?.fileName, "narration-slide-01.mp3");
  assert.equal("renderSrc" in (manifest.audioTracks[0] ?? {}), false);
  assert.equal("renderSrc" in (manifest.spec.audioTracks[0] ?? {}), false);
});

test("video presentation project manifest is parseable as a scene spec root", async () => {
  const { videoPresentationSpecSchema } = await import(
    "@sourceweft/contracts/video-presentation"
  );
  const manifest = testExports.buildProjectManifest({
    spec,
    fileName: "launch.video-presentation.json",
    title: "Launch plan",
  });

  assert.equal(videoPresentationSpecSchema.safeParse(manifest).success, true);
});

test("failed payload records render failure without ready state", () => {
  assert.deepEqual(
    testExports.buildFailedPayload({
      currentPayload: {
        artifactKind: "video_presentation",
        generation: { status: "running", stage: "finalizing_project" },
      },
      errorCode: "VIDEO_PRESENTATION_RENDER_FAILED",
      errorMessage: "TTS failed",
    }),
    {
      artifactKind: "video_presentation",
      generation: {
        status: "failed",
        stage: "failed",
        errorCode: "VIDEO_PRESENTATION_RENDER_FAILED",
        errorMessage: "TTS failed",
      },
    },
  );
});

test("timeout error uses a clear project generation message", () => {
  assert.equal(
    testExports.createTimeoutError(240_000).message,
    "Video presentation project generation timed out after 240s.",
  );
});
