import assert from "node:assert/strict";
import { test } from "node:test";

import { videoPresentationProjectPayloadSchema } from "@sourceweft/contracts/video-presentation";
import { videoPresentationArtifactViewHandler } from "../src/artifact-view";
import { buildProjectCodePayload } from "../src/pipeline/project-code";
import {
  classifyRenderVideoFailure,
  parseRenderVideoReport,
  parseSceneChunkReport,
  renderVideoSlideNumbers,
  sceneChunkCommand,
  uploadRenderedVideo,
  MAX_STORED_VIDEO_BYTES,
} from "../src/pipeline/render-video";
import { runProjectInSession } from "../src/pipeline/sandbox-project";

/**
 * The mp4 render itself needs a live sandbox (Daytona), a chromium install and
 * @remotion/renderer's ffmpeg binaries, none of which exist in CI — so none of
 * these tests render a real video. They cover the layer beneath it: what the
 * generated project asks the renderer to do, which sandbox commands run and in
 * what order, how failures are classified, and where the bytes are written.
 */

function payloadFixture(slideCount = 1) {
  const slides = Array.from({ length: slideCount }, (_, index) => index + 1);
  return videoPresentationProjectPayloadSchema.parse({
    schemaVersion: 2,
    kind: "video_presentation",
    generation: { status: "running", stage: "installing_project", progress: 0 },
    project: {
      title: "Quarterly Review",
      fps: 30,
      width: 1920,
      height: 1080,
      stylePreset: "cinematic",
      globalVisualDirection: "cinematic dark",
    },
    slides: slides.map((slideNumber) => ({
      slideNumber,
      title: `Slide ${slideNumber}`,
      speakerTranscript: ["Hello."],
      sceneIntent: "open the deck",
    })),
    sceneModules: slides.map((slideNumber) => ({
      slideNumber,
      title: `Slide ${slideNumber}`,
      code: "export default function VideoScene() { return null; }",
      // Uneven on purpose: the concat path must not assume equal-length scenes.
      durationInFrames: 90 * slideNumber,
    })),
    renderProfile: {},
    sourceDigest: "digest",
  });
}

function fileContent(
  files: ReadonlyArray<{ path: string; content: string }>,
  path: string,
) {
  const file = files.find((entry) => entry.path === path);
  assert.ok(file, `expected generated file ${path}`);
  return file.content;
}

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function collectingLogger() {
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> =
    [];
  return {
    warnings,
    logger: {
      info: () => undefined,
      warn: (message: string, meta?: Record<string, unknown>) => {
        warnings.push({ message, ...(meta ? { meta } : {}) });
      },
      error: () => undefined,
    },
  };
}

const job = {
  artifactId: "artifact-1",
  jobId: "job-1",
  toolCallId: "call-1",
  workspaceId: "workspace-1",
} as never;

type FakeSessionOptions = {
  /** Commands (matched by substring) that should exit non-zero. */
  failing?: readonly string[];
  stdoutFor?: (command: string) => string | undefined;
  /** Output a failing command emits, e.g. a sandbox timeout notice. */
  failureOutputFor?: (command: string) => string | undefined;
  downloads?: Record<string, Uint8Array>;
};

function fakeSession(options: FakeSessionOptions = {}) {
  const commands: string[] = [];
  const uploaded: string[] = [];
  const downloaded: string[] = [];
  return {
    commands,
    uploaded,
    downloaded,
    session: {
      rootDir: "/workspace",
      uploadFiles: async (files: Array<[string, Uint8Array]>) => {
        uploaded.push(...files.map(([path]) => path));
        return files.map(([path]) => ({ path, error: null }));
      },
      execute: async (command: string) => {
        commands.push(command);
        const failed = (options.failing ?? []).some((needle) =>
          command.includes(needle),
        );
        return {
          exitCode: failed ? 1 : 0,
          output: failed
            ? (options.failureOutputFor?.(command) ??
              `command failed: ${command}`)
            : (options.stdoutFor?.(command) ?? "ok"),
        };
      },
      downloadFiles: async (paths: string[]) => {
        downloaded.push(...paths);
        return paths.map((path) => {
          const content = options.downloads?.[path];
          return content
            ? { path, content, error: null }
            : { path, content: null, error: "file_not_found" };
        });
      },
    },
  };
}

const RENDER_REPORT_LINE = JSON.stringify({
  ok: true,
  stage: "render-video",
  file: "out/video.mp4",
  byteLength: 4,
  durationInFrames: 90,
  fps: 30,
  width: 1920,
  height: 1080,
  hasAudio: false,
});

/* -------------------------------------------------------------------------- */
/* Generated project                                                          */
/* -------------------------------------------------------------------------- */

test("the generated project renders per scene, never the whole deck at once", () => {
  const project = buildProjectCodePayload(payloadFixture(3));
  assert.equal(
    project.files.find((file) => file.path === "scripts/render-video.mjs"),
    undefined,
  );
  const packageJson = fileContent(project.files, "package.json");
  assert.match(
    packageJson,
    /"render-scene": "node scripts\/render-scene\.mjs"/,
  );
  assert.match(
    packageJson,
    /"render-audio": "node scripts\/render-audio\.mjs"/,
  );
  assert.match(
    packageJson,
    /"concat-video": "node scripts\/concat-video\.mjs"/,
  );
  assert.doesNotMatch(packageJson, /"render-video"/);

  const script = fileContent(project.files, "scripts/render-scene.mjs");
  // One slide per invocation, rendered as a frameRange of the single
  // composition so every chunk shares encoder settings.
  assert.match(script, /const slideNumber = Number\(process\.argv\[2\]\);/);
  assert.match(script, /frameRange: \[from, to\]/);
  assert.match(script, /const to = from \+ scene\.durationInFrames - 1;/);
  assert.match(script, /codec: "h264-ts"/);
  // Chunks are silent; narration is mixed once by render-audio.
  assert.match(script, /muted: true/);
  assert.match(script, /out\/scenes\//);

  // The stills path must be untouched by the change.
  assert.match(
    fileContent(project.files, "scripts/render-stills.mjs"),
    /renderStill/,
  );
});

test("a scene chunk is only reused when its source and frame range match", () => {
  const script = fileContent(
    buildProjectCodePayload(payloadFixture(2)).files,
    "scripts/render-scene.mjs",
  );
  assert.match(script, /createHash\("sha256"\)/);
  assert.match(script, /JSON\.stringify\(\{ digest, from, to \}\)/);
  assert.match(script, /const reused =/);
  assert.match(script, /writeFileSync\(sidecarFile, sidecar\);/);
  // The report says whether work was skipped, so a resumed run is visible.
  assert.match(script, /"render-scene"[\s\S]*reused/);
});

test("the concat script stream-copies chunks and refuses an incomplete set", () => {
  const project = buildProjectCodePayload(payloadFixture(3));
  const script = fileContent(project.files, "scripts/concat-video.mjs");
  // combineChunks with codec h264 concatenates video without re-encoding.
  assert.match(
    script,
    /import \{ combineChunks \} from "@remotion\/renderer";/,
  );
  assert.match(script, /codec: "h264"/);
  assert.doesNotMatch(script, /renderMedia/);
  assert.match(script, /throw new Error\(`missing chunk for slide/);
  assert.match(script, /framesPerChunk: manifest\.durationInFrames/);
  assert.match(script, /stage: "render-video"/);

  // The audio mix is one whole-composition pass, not one per scene, because
  // combineChunks assumes uniform chunk lengths when reassembling audio.
  const audio = fileContent(project.files, "scripts/render-audio.mjs");
  assert.match(audio, /codec: "aac"/);
  assert.doesNotMatch(audio, /frameRange/);
  assert.match(script, /narrated deck is missing its rendered audio mix/);
});

test("the slides an mp4 render covers match the generated composition", () => {
  assert.deepEqual(renderVideoSlideNumbers(payloadFixture(3)), [1, 2, 3]);
  // An empty payload is rendered as a synthesized title card for slide 1, so
  // the render must ask for that slide rather than for nothing.
  assert.deepEqual(renderVideoSlideNumbers({ sceneModules: [] } as never), [1]);
  assert.equal(sceneChunkCommand(4), "pnpm run render-scene -- 4");
});

test("without narration the composition is unchanged (no audio wiring)", () => {
  const project = buildProjectCodePayload(payloadFixture());
  const scene = fileContent(project.files, "src/VideoScene.tsx");
  assert.match(scene, /import \{ AbsoluteFill, Sequence \} from "remotion";/);
  assert.doesNotMatch(scene, /Audio/);
  assert.doesNotMatch(scene, /narrationFile/);
  assert.doesNotMatch(
    fileContent(project.files, "video-presentation.manifest.json"),
    /narrationFile/,
  );
});

test("staged narration is wired into the composition through staticFile", () => {
  const project = buildProjectCodePayload(payloadFixture(), {
    narrationFiles: [{ slideNumber: 1, fileName: "slide-1.mp3" }],
  });
  const scene = fileContent(project.files, "src/VideoScene.tsx");
  assert.match(scene, /Audio/);
  assert.match(scene, /staticFile\("audio\/" \+ scene\.narrationFile\)/);
  assert.match(scene, /narrationFile: "slide-1\.mp3"/);
  assert.match(
    fileContent(project.files, "video-presentation.manifest.json"),
    /"narrationFile": "slide-1\.mp3"/,
  );
});

/* -------------------------------------------------------------------------- */
/* Sandbox orchestration                                                      */
/* -------------------------------------------------------------------------- */

/** Stdout the per-scene / audio / concat commands print when they succeed. */
function renderStdout(command: string) {
  const scene = /render-scene -- (\d+)/u.exec(command);
  if (scene) {
    const slideNumber = Number(scene[1]);
    return JSON.stringify({
      ok: true,
      stage: "render-scene",
      slideNumber,
      file: `out/scenes/scene-${slideNumber}.ts`,
      byteLength: 128,
      from: 0,
      to: 89,
      reused: false,
    });
  }
  if (command.includes("render-audio")) {
    return JSON.stringify({
      ok: true,
      stage: "render-audio",
      file: null,
      byteLength: 0,
      reused: false,
    });
  }
  if (command.includes("concat-video")) {
    return `Combining chunks\n${RENDER_REPORT_LINE}`;
  }
  return undefined;
}

/** The mp4-producing commands, in the order they were issued. */
function renderCommands(commands: readonly string[]) {
  return commands.flatMap((command) => {
    const scene = /render-scene -- (\d+)/u.exec(command);
    if (scene) {
      return [`scene:${scene[1]}`];
    }
    if (command.includes("render-audio")) {
      return ["audio"];
    }
    if (command.includes("concat-video")) {
      return ["concat"];
    }
    return [];
  });
}

test("a run that does not ask for an mp4 never invokes the renderer", async () => {
  const fake = fakeSession();
  const result = await runProjectInSession({
    session: fake.session as never,
    logger,
    job,
    payload: payloadFixture(),
  });
  assert.equal(result.video, undefined);
  assert.deepEqual(renderCommands(fake.commands), []);
  assert.ok(fake.commands.some((command) => command.includes("render-stills")));
  assert.ok(!fake.uploaded.some((path) => path.includes("public/audio/")));
});

test("the opt-in render runs one command per scene, then mixes and joins", async () => {
  const video = new Uint8Array([1, 2, 3, 4]);
  const fake = fakeSession({
    stdoutFor: renderStdout,
    downloads: {
      "/workspace/video-presentation-artifact-1/out/video.mp4": video,
    },
  });
  const result = await runProjectInSession({
    session: fake.session as never,
    logger,
    job,
    payload: payloadFixture(3),
    renderVideo: {
      narration: [
        {
          slideNumber: 1,
          fileName: "slide-1.mp3",
          data: new Uint8Array([9]),
        },
      ],
    },
  });

  assert.ok(
    fake.uploaded.includes(
      "/workspace/video-presentation-artifact-1/public/audio/slide-1.mp3",
    ),
  );
  // Scenes in playback order, then the single narration mix, then the join.
  assert.deepEqual(renderCommands(fake.commands), [
    "scene:1",
    "scene:2",
    "scene:3",
    "audio",
    "concat",
  ]);
  // Each scene is its own sandbox execute, so each carries the budget of one
  // scene rather than the whole deck.
  assert.ok(
    fake.commands.every((command) => !/render-scene(?! -- \d)/u.test(command)),
  );
  // The mp4 render reuses the renderer deps the stills step installs.
  const rendererInstallIndex = fake.commands.findIndex((command) =>
    command.includes("@remotion/renderer"),
  );
  const firstSceneIndex = fake.commands.findIndex((command) =>
    command.includes("render-scene"),
  );
  assert.ok(
    rendererInstallIndex >= 0 && firstSceneIndex > rendererInstallIndex,
  );
  assert.deepEqual(result.video?.data, video);
  assert.equal(result.video?.report.durationInFrames, 90);
  assert.equal(result.video?.report.width, 1920);
  // Install/typecheck/smoke results are unaffected by the extra steps.
  assert.equal(result.install.ok, true);
  assert.equal(result.smoke.ok, true);
});

test("a scene that outruns the command timeout fails the whole render", async () => {
  const collected = collectingLogger();
  const fake = fakeSession({
    // Only slide 2 times out; slides 1 and 3 would render fine.
    failing: ["render-scene -- 2"],
    stdoutFor: renderStdout,
    failureOutputFor: () =>
      "SANDBOX_COMMAND_TIMEOUT: sandbox command exceeded the configured timeout.",
  });
  const result = await runProjectInSession({
    session: fake.session as never,
    logger: collected.logger,
    job,
    payload: payloadFixture(3),
    renderVideo: {},
  });

  assert.equal(result.video, undefined);
  // Stops at the failing scene: slide 3 is never rendered, nothing is joined,
  // and no partial mp4 is downloaded or reported as a finished video.
  assert.deepEqual(renderCommands(fake.commands), ["scene:1", "scene:2"]);
  assert.deepEqual(
    fake.downloaded.filter((path) => path.endsWith(".mp4")),
    [],
  );
  const warning = collected.warnings.find(
    (entry) => entry.message === "video_presentation_render_video_unavailable",
  );
  assert.equal(warning?.meta?.reason, "timeout");
  assert.equal(warning?.meta?.slideNumber, 2);
  // The rest of the pipeline is unaffected: this is a degradation, not a failure.
  assert.equal(result.smoke.ok, true);
});

test("a scene command that prints no usable report degrades too", async () => {
  const collected = collectingLogger();
  const fake = fakeSession({
    stdoutFor: (command) =>
      command.includes("render-scene -- 2")
        ? "Rendering 30/90"
        : renderStdout(command),
  });
  const result = await runProjectInSession({
    session: fake.session as never,
    logger: collected.logger,
    job,
    payload: payloadFixture(3),
    renderVideo: {},
  });
  assert.equal(result.video, undefined);
  assert.deepEqual(renderCommands(fake.commands), ["scene:1", "scene:2"]);
  assert.equal(
    collected.warnings.find(
      (entry) =>
        entry.message === "video_presentation_render_video_unavailable",
    )?.meta?.reason,
    "unreadable_scene_report",
  );
});

test("a failed narration mix stops the render before it can be joined", async () => {
  const collected = collectingLogger();
  const fake = fakeSession({
    failing: ["render-audio"],
    stdoutFor: renderStdout,
  });
  const result = await runProjectInSession({
    session: fake.session as never,
    logger: collected.logger,
    job,
    payload: payloadFixture(2),
    renderVideo: {},
  });
  assert.equal(result.video, undefined);
  assert.deepEqual(renderCommands(fake.commands), [
    "scene:1",
    "scene:2",
    "audio",
  ]);
  const warning = collected.warnings.find(
    (entry) => entry.message === "video_presentation_render_video_unavailable",
  );
  assert.equal(warning?.meta?.stage, "render-audio");
  assert.equal(warning?.meta?.reason, "render_failed");
});

test("a failed join degrades to no video and warns with a reason", async () => {
  const collected = collectingLogger();
  const fake = fakeSession({
    failing: ["concat-video"],
    stdoutFor: renderStdout,
  });
  const result = await runProjectInSession({
    session: fake.session as never,
    logger: collected.logger,
    job,
    payload: payloadFixture(2),
    renderVideo: {},
  });
  assert.equal(result.video, undefined);
  assert.equal(result.smoke.ok, true);
  const warning = collected.warnings.find(
    (entry) => entry.message === "video_presentation_render_video_unavailable",
  );
  assert.equal(warning?.meta?.reason, "concat_failed");
});

test("an oversized render is reported, never downloaded", async () => {
  const collected = collectingLogger();
  const fake = fakeSession({
    stdoutFor: (command) =>
      command.includes("concat-video")
        ? JSON.stringify({
            ok: true,
            stage: "render-video",
            file: "out/video.mp4",
            byteLength: 512 * 1024 * 1024,
            durationInFrames: 90,
            fps: 30,
            width: 1920,
            height: 1080,
            hasAudio: false,
          })
        : renderStdout(command),
  });
  const result = await runProjectInSession({
    session: fake.session as never,
    logger: collected.logger,
    job,
    payload: payloadFixture(),
    renderVideo: {},
  });
  assert.equal(result.video, undefined);
  assert.ok(!fake.downloaded.some((path) => path.endsWith("video.mp4")));
  assert.equal(
    collected.warnings.find(
      (entry) =>
        entry.message === "video_presentation_render_video_unavailable",
    )?.meta?.reason,
    "oversized",
  );
});

/* -------------------------------------------------------------------------- */
/* Report parsing and failure classification                                  */
/* -------------------------------------------------------------------------- */

test("the render report is read out of noisy renderer stdout", () => {
  const report = parseRenderVideoReport(
    `bundling...\nRendering 45/90\n${RENDER_REPORT_LINE}\n`,
  );
  assert.equal(report?.fps, 30);
  assert.equal(report?.byteLength, 4);
  assert.equal(report?.hasAudio, false);
});

test("malformed or empty render reports parse to null", () => {
  assert.equal(parseRenderVideoReport(undefined), null);
  assert.equal(parseRenderVideoReport("Rendering 45/90"), null);
  assert.equal(
    parseRenderVideoReport(
      JSON.stringify({
        ok: true,
        stage: "render-video",
        file: "out/video.mp4",
      }),
    ),
    null,
  );
  assert.equal(
    parseRenderVideoReport(
      JSON.stringify({
        ok: true,
        stage: "render-video",
        file: "out/video.mp4",
        byteLength: 0,
        durationInFrames: 90,
        fps: 30,
        width: 1920,
        height: 1080,
      }),
    ),
    null,
  );
});

test("a scene chunk report is read, and a mismatched one refused", () => {
  const line = JSON.stringify({
    ok: true,
    stage: "render-scene",
    slideNumber: 2,
    file: "out/scenes/scene-2.ts",
    byteLength: 4096,
    from: 90,
    to: 269,
    reused: true,
  });
  const report = parseSceneChunkReport(`bundling...\n${line}`, 2);
  assert.equal(report?.from, 90);
  assert.equal(report?.to, 269);
  assert.equal(report?.reused, true);

  // A report for another slide is not this slide's chunk.
  assert.equal(parseSceneChunkReport(line, 3), null);
  assert.equal(parseSceneChunkReport("Rendering 30/90", 2), null);
  assert.equal(parseSceneChunkReport(undefined, 2), null);
  // An empty chunk file is no chunk at all.
  assert.equal(
    parseSceneChunkReport(
      JSON.stringify({
        ok: true,
        stage: "render-scene",
        slideNumber: 2,
        file: "out/scenes/scene-2.ts",
        byteLength: 0,
        from: 90,
        to: 269,
      }),
      2,
    ),
    null,
  );
});

test("render failures are classified so timeouts are distinguishable", () => {
  assert.equal(
    classifyRenderVideoFailure({
      diagnostics: [
        "SANDBOX_COMMAND_TIMEOUT: sandbox command exceeded the configured timeout.",
      ],
    }),
    "timeout",
  );
  assert.equal(
    classifyRenderVideoFailure({
      diagnostics: ["Error: Cannot find module '@remotion/renderer'"],
    }),
    "renderer_unavailable",
  );
  assert.equal(
    classifyRenderVideoFailure({ diagnostics: ["Scene 2 threw at frame 12"] }),
    "render_failed",
  );
});

/* -------------------------------------------------------------------------- */
/* Storage                                                                    */
/* -------------------------------------------------------------------------- */

function fakeStorage() {
  const uploads: Array<{ key: string; contentType: string; bytes: number }> =
    [];
  return {
    uploads,
    storage: {
      buildArtifactStorageKey: (input: {
        artifactId: string;
        fileName: string;
        workspaceId: string;
      }) => `${input.workspaceId}/${input.artifactId}/${input.fileName}`,
      getBucketName: () => "content",
      upload: async (input: {
        body: Uint8Array;
        contentType: string;
        key: string;
      }) => {
        uploads.push({
          key: input.key,
          contentType: input.contentType,
          bytes: input.body.byteLength,
        });
      },
    },
  };
}

const report = {
  file: "out/video.mp4",
  byteLength: 4,
  durationInFrames: 90,
  fps: 30,
  width: 1920,
  height: 1080,
  hasAudio: true,
};

test("the mp4 is stored through the same artifact asset path narration uses", async () => {
  const fake = fakeStorage();
  const record = await uploadRenderedVideo({
    artifactId: "artifact-1",
    payload: payloadFixture(),
    report,
    storage: fake.storage as never,
    video: new Uint8Array([1, 2, 3, 4]),
    workspaceId: "workspace-1",
  });

  assert.deepEqual(fake.uploads, [
    {
      key: "workspace-1/artifact-1/Quarterly-Review.mp4",
      contentType: "video/mp4",
      bytes: 4,
    },
  ]);
  assert.equal(record?.fileName, "Quarterly-Review.mp4");
  assert.equal(record?.mimeType, "video/mp4");
  assert.equal(record?.storageBucket, "content");
  assert.equal(
    record?.assetUrl,
    "/v1/workspaces/workspace-1/artifacts/artifact-1/assets/Quarterly-Review.mp4",
  );
  assert.equal(record?.hasAudio, true);
  assert.equal(record?.byteLength, 4);
});

test("an empty or oversized mp4 is never uploaded", async () => {
  const fake = fakeStorage();
  const base = {
    artifactId: "artifact-1",
    payload: payloadFixture(),
    report,
    storage: fake.storage as never,
    workspaceId: "workspace-1",
  };
  assert.equal(
    await uploadRenderedVideo({ ...base, video: new Uint8Array() }),
    null,
  );
  assert.equal(
    await uploadRenderedVideo({
      ...base,
      video: new Uint8Array(MAX_STORED_VIDEO_BYTES + 1),
    }),
    null,
  );
  assert.deepEqual(fake.uploads, []);
});

test("a stored mp4 resolves as an artifact asset; payloads without one do not", () => {
  const resolve = videoPresentationArtifactViewHandler.resolveAsset;
  const artifact = {
    artifactType: "video_presentation",
    status: "ready",
    storageBucket: "content",
    storageKey: null,
    payloadJson: {
      renderedVideo: {
        fileName: "Quarterly-Review.mp4",
        mimeType: "video/mp4",
        storageKey: "workspace-1/artifact-1/Quarterly-Review.mp4",
      },
    },
  } as never;

  assert.deepEqual(resolve?.({ artifact, fileName: "Quarterly-Review.mp4" }), {
    contentType: "video/mp4",
    fileName: "Quarterly-Review.mp4",
    storageBucket: "content",
    storageKey: "workspace-1/artifact-1/Quarterly-Review.mp4",
  });
  assert.equal(
    resolve?.({
      artifact: {
        artifactType: "video_presentation",
        status: "ready",
        storageBucket: "content",
        storageKey: null,
        payloadJson: {},
      } as never,
      fileName: "Quarterly-Review.mp4",
    }),
    null,
  );
});
