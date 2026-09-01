import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { videoPresentationRenderableProjectSchema } from "@sourceweft/contracts/video-presentation";
import {
  buildProjectCodePayload,
  buildValidationProjectCodePayload,
} from "../src/pipeline/project-code";

function payloadWithScenes() {
  return videoPresentationRenderableProjectSchema.parse({
    narrationPolicy: { enabled: false },
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
          "export default function VideoScene() {",
          "  return <AbsoluteFill>Agenda</AbsoluteFill>;",
          "}",
        ].join("\n"),
        componentName: "VideoScene",
        durationInFrames: 180,
        diagnostics: [],
        layoutWarnings: [],
        compileStatus: "compiled",
      },
    ],
    audioTracks: [],
    assets: [],
    preview: { slideCount: 1, durationSeconds: 6 },
    renderProfile: {
      stylePreset: "cinematic",
      visualDensity: "balanced",
      durationTarget: "medium",
      language: "auto",
    },
    sourceDigest: "demo",
    themeAssignments: [],
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

test("sandbox bundle installs a no-egress CSP before importing authored scenes", () => {
  const payload = buildProjectCodePayload(payloadWithScenes());
  const entry = payload.files.find((file) => file.path === "src/index.ts");
  const security = payload.files.find(
    (file) => file.path === "src/security.ts",
  );
  assert.ok(entry);
  assert.ok(security);
  assert.equal(entry.content.split("\n")[0], 'import "./security";');
  assert.match(security.content, /connect-src 'none'/u);
  assert.match(security.content, /img-src 'self' data: blob:/u);
  assert.match(security.content, /media-src 'self' data: blob:/u);
});

test("current validation bundles exactly once and every render phase reuses it", () => {
  const project = buildValidationProjectCodePayload(payloadWithScenes());
  const content = (path: string) => {
    const file = project.files.find((candidate) => candidate.path === path);
    assert.ok(file, `expected ${path}`);
    return file.content;
  };

  assert.match(content("scripts/prepare-render.mjs"), /bundle\(/u);
  assert.match(content("pnpm-lock.yaml"), /lockfileVersion: '9\.0'/u);
  assert.match(
    content("pnpm-lock.yaml"),
    /'@remotion\/renderer':\n\s+specifier: 4\.0\.468\n\s+version: 4\.0\.468/u,
  );
  assert.match(
    content("pnpm-lock.yaml"),
    /typescript:\n\s+specifier: 5\.9\.2\n\s+version: 5\.9\.2/u,
  );
  assert.match(
    content("scripts/prepare-render.mjs"),
    /SOURCEWEFT_REMOTION_BROWSER is required/u,
  );
  assert.doesNotMatch(
    content("scripts/prepare-render.mjs"),
    /await ensureBrowser\(\);/u,
  );
  assert.equal(
    project.files.reduce(
      (count, file) =>
        count + (file.content.match(/\bbundle\(/gu)?.length ?? 0),
      0,
    ),
    1,
  );
  for (const path of [
    "scripts/render-validation-samples.mjs",
    "scripts/render-scene.mjs",
    "scripts/render-audio.mjs",
  ]) {
    assert.doesNotMatch(content(path), /bundle\(/u, path);
    assert.match(content(path), /out\/bundle/u, path);
  }
});

test("generated package manifest and lockfile form a frozen dependency closure", () => {
  const project = buildValidationProjectCodePayload(payloadWithScenes());
  const packageFile = project.files.find(
    (file) => file.path === "package.json",
  );
  const lockFile = project.files.find((file) => file.path === "pnpm-lock.yaml");
  assert.ok(packageFile);
  assert.ok(lockFile);
  const directory = mkdtempSync(join(tmpdir(), "sourceweft-video-lock-"));
  try {
    writeFileSync(join(directory, packageFile.path), packageFile.content);
    writeFileSync(join(directory, lockFile.path), lockFile.content);
    execFileSync(
      "pnpm",
      [
        "install",
        "--lockfile-only",
        "--frozen-lockfile",
        "--offline",
        "--ignore-scripts",
      ],
      { cwd: directory, stdio: "pipe" },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every generated trusted render script is valid ESM syntax", () => {
  const project = buildValidationProjectCodePayload(payloadWithScenes());
  const directory = mkdtempSync(join(tmpdir(), "sourceweft-video-scripts-"));
  try {
    for (const file of project.files.filter((candidate) =>
      candidate.path.endsWith(".mjs"),
    )) {
      const path = join(directory, file.path.replaceAll("/", "-"));
      writeFileSync(path, file.content);
      execFileSync(process.execPath, ["--check", path], { stdio: "pipe" });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
