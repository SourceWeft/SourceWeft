import assert from "node:assert/strict";
import { test } from "node:test";

import { videoPresentationProjectPayloadSchema } from "@sourceweft/contracts/video-presentation";
import { videoPresentationArtifactViewHandler } from "../src/artifact-view";
import { buildProjectCodePayload } from "../src/pipeline/project-code";
import {
  classifyRenderVideoFailure,
  parseRenderVideoReport,
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

function payloadFixture() {
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
    slides: [
      {
        slideNumber: 1,
        title: "Opening",
        speakerTranscript: ["Hello."],
        sceneIntent: "open the deck",
      },
    ],
    sceneModules: [
      {
        slideNumber: 1,
        title: "Opening",
        code: "export default function VideoScene() { return null; }",
        durationInFrames: 90,
      },
    ],
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
            ? `command failed: ${command}`
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

test("the generated project ships a renderMedia script alongside renderStill", () => {
  const project = buildProjectCodePayload(payloadFixture());
  const script = fileContent(project.files, "scripts/render-video.mjs");
  assert.match(script, /renderMedia/);
  assert.match(script, /codec: "h264"/);
  assert.match(script, /outputLocation: output/);
  assert.match(script, /out\/video\.mp4/);
  assert.match(
    fileContent(project.files, "package.json"),
    /"render-video": "node scripts\/render-video\.mjs"/,
  );
  // The stills path must be untouched by the addition.
  assert.match(
    fileContent(project.files, "scripts/render-stills.mjs"),
    /renderStill/,
  );
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

test("a run that does not ask for an mp4 never invokes the renderer", async () => {
  const fake = fakeSession();
  const result = await runProjectInSession({
    session: fake.session as never,
    logger,
    job,
    payload: payloadFixture(),
  });
  assert.equal(result.video, undefined);
  assert.ok(!fake.commands.some((command) => command.includes("render-video")));
  assert.ok(fake.commands.some((command) => command.includes("render-stills")));
  assert.ok(!fake.uploaded.some((path) => path.includes("public/audio/")));
});

test("the opt-in render uploads narration, renders, and returns the mp4", async () => {
  const video = new Uint8Array([1, 2, 3, 4]);
  const fake = fakeSession({
    stdoutFor: (command) =>
      command.includes("render-video")
        ? `Rendering 30/90\n${RENDER_REPORT_LINE}`
        : undefined,
    downloads: {
      "/workspace/video-presentation-artifact-1/out/video.mp4": video,
    },
  });
  const result = await runProjectInSession({
    session: fake.session as never,
    logger,
    job,
    payload: payloadFixture(),
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
  // The mp4 render reuses the renderer deps the stills step installs.
  const rendererInstallIndex = fake.commands.findIndex((command) =>
    command.includes("@remotion/renderer"),
  );
  const renderVideoIndex = fake.commands.findIndex((command) =>
    command.includes("render-video"),
  );
  assert.ok(
    rendererInstallIndex >= 0 && renderVideoIndex > rendererInstallIndex,
  );
  assert.deepEqual(result.video?.data, video);
  assert.equal(result.video?.report.durationInFrames, 90);
  assert.equal(result.video?.report.width, 1920);
  // Install/typecheck/smoke results are unaffected by the extra step.
  assert.equal(result.install.ok, true);
  assert.equal(result.smoke.ok, true);
});

test("a failed mp4 render degrades to no video and warns with a reason", async () => {
  const collected = collectingLogger();
  const fake = fakeSession({ failing: ["render-video"] });
  const result = await runProjectInSession({
    session: fake.session as never,
    logger: collected.logger,
    job,
    payload: payloadFixture(),
    renderVideo: {},
  });
  assert.equal(result.video, undefined);
  assert.equal(result.smoke.ok, true);
  const warning = collected.warnings.find(
    (entry) => entry.message === "video_presentation_render_video_unavailable",
  );
  assert.equal(warning?.meta?.reason, "render_failed");
});

test("an oversized render is reported, never downloaded", async () => {
  const collected = collectingLogger();
  const fake = fakeSession({
    stdoutFor: (command) =>
      command.includes("render-video")
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
        : undefined,
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
