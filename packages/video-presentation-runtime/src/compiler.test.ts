import assert from "node:assert/strict";
import { test } from "vitest";
import {
  compileSceneModuleOnBrowser,
  compileVideoPresentationScenesOnBrowser,
} from "./compiler";
import type { VideoPresentationProjectPayload } from "@sourceweft/contracts/video-presentation";

function payload(code: string): VideoPresentationProjectPayload {
  return {
    schemaVersion: 2,
    kind: "video_presentation",
    generation: {
      status: "ready",
      stage: "ready",
      progress: 100,
    },
    project: {
      title: "Runtime Test",
      fps: 30,
      width: 1920,
      height: 1080,
      durationSeconds: 3,
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
    audioTracks: [],
    sceneModules: [
      {
        slideNumber: 1,
        title: "Scene One",
        componentName: "VideoScene",
        code,
        durationInFrames: 90,
        repairAttempts: 0,
        diagnostics: [],
        layoutWarnings: [],
        compileStatus: "compiled",
      },
    ],
    assets: [],
    preview: {
      slideCount: 1,
      durationSeconds: 3,
    },
    renderProfile: {
      stylePreset: "cinematic",
      visualDensity: "balanced",
      durationTarget: "short",
      language: "en-US",
    },
    themeAssignments: [],
    sourceDigest: "Test digest",
  };
}

test("compileSceneModuleOnBrowser compiles exported Remotion scene code", async () => {
  const component = await compileSceneModuleOnBrowser(
    `
import React from "react";
import { AbsoluteFill } from "remotion";

export default function VideoScene() {
  return <AbsoluteFill style={{ background: "#000" }}>Hello</AbsoluteFill>;
}
`,
    "VideoScene",
  );

  assert.equal(typeof component, "function");
});

test("compileVideoPresentationScenesOnBrowser throws on failed scene by default", async () => {
  await assert.rejects(
    () =>
      compileVideoPresentationScenesOnBrowser(
        payload("export default function VideoScene() { return <AbsoluteFill>;"),
      ),
    /Unexpected token|Unterminated|unterminated|expected|Adjacent JSX|Scene compiler/u,
  );
});

test("compileVideoPresentationScenesOnBrowser only falls back when explicitly requested", async () => {
  const result = await compileVideoPresentationScenesOnBrowser(
    payload("export default function VideoScene() { return <AbsoluteFill>;"),
    { useFallbackForFailedScenes: true },
  );

  assert.equal(result.scenes.length, 1);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.slideNumber, 1);
});
