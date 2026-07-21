import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInitialVideoPresentationPipelineSteps,
  videoPresentationProjectPayloadSchema,
} from "@sourceweft/contracts/video-presentation";
import { buildProjectCodePayload } from "../src/pipeline/project-code";

function payloadWithScenes() {
  return videoPresentationProjectPayloadSchema.parse({
    schemaVersion: 2,
    kind: "video_presentation",
    generation: {
      status: "running",
      stage: "installing_project",
      progress: 40,
      pipelineSteps: buildInitialVideoPresentationPipelineSteps(),
    },
    project: {
      title: "Quarterly Review",
      fps: 30,
      width: 1920,
      height: 1080,
      durationSeconds: 6,
      stylePreset: "cinematic",
      globalVisualDirection: "Clean executive deck",
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
    sceneModules: [
      {
        slideNumber: 1,
        title: "Agenda",
        code: [
          'import React from "react";',
          'import { AbsoluteFill } from "remotion";',
          "export default function Slide1() {",
          '  return <AbsoluteFill>Agenda</AbsoluteFill>;',
          "}",
        ].join("\n"),
        componentName: "Slide1",
        durationInFrames: 180,
        repairAttempts: 0,
        diagnostics: [],
        compileStatus: "compiled",
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

// Model-authored scene code is never type-checked by the generated project's
// `tsc` run, so every emitted scene file has to opt out explicitly. Without
// this, one loose `any` in a generated scene fails the whole pipeline at the
// typechecking stage.
test("generated scene files are emitted with @ts-nocheck", () => {
  const { files } = buildProjectCodePayload(payloadWithScenes());
  const scene = files.find((file) => file.path === "src/scenes/Slide1.tsx");
  assert.ok(scene, "expected a file for slide 1");
  assert.match(scene.content, /^\/\/ @ts-nocheck$/mu);
});

test("the fallback scene emitted for an empty deck also carries @ts-nocheck", () => {
  const base = payloadWithScenes();
  const { files } = buildProjectCodePayload({ ...base, sceneModules: [] });
  const scene = files.find((file) => file.path === "src/scenes/Slide1.tsx");
  assert.ok(scene, "expected a fallback file for slide 1");
  assert.match(scene.content, /^\/\/ @ts-nocheck$/mu);
});

test("the generated project's entry file is emitted even though it is not persisted", () => {
  const payload = buildProjectCodePayload(payloadWithScenes());
  assert.equal(payload.entryFile, "src/index.ts");
  assert.ok(payload.files.some((file) => file.path === payload.entryFile));
});
