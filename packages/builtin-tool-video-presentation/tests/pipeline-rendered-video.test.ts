import assert from "node:assert/strict";
import { test } from "node:test";

import { videoPresentationProjectPayloadSchema } from "@sourceweft/contracts/video-presentation";
import { createVideoPresentationPipelineDefinition } from "../src/pipeline/definition";
import { attachReadySourceJson } from "../src/pipeline/finalize";

/**
 * The server-side mp4 render was removed: every surface (owner preview AND
 * public share) client-compiles the Remotion project, so the sandbox only
 * installs/typechecks/smoke-renders stills and never muxes an mp4. These drive
 * the real stage functions with a fake sandbox result to lock that in — the
 * install stage never asks for a render, and publish never stores one.
 */

const job = {
  artifactId: "artifact-1",
  jobId: "job-1",
  toolCallId: "call-1",
  workspaceId: "workspace-1",
} as never;

function payloadFixture() {
  return videoPresentationProjectPayloadSchema.parse({
    schemaVersion: 2,
    kind: "video_presentation",
    generation: {
      status: "running",
      stage: "publishing_video_project",
      progress: 90,
    },
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
        title: "Slide 1",
        speakerTranscript: ["Hello."],
        sceneIntent: "open the deck",
      },
    ],
    sceneModules: [
      {
        slideNumber: 1,
        title: "Slide 1",
        code: "export default function VideoScene() { return null; }",
        durationInFrames: 90,
      },
    ],
    renderProfile: {},
    sourceDigest: "digest",
  });
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

function stageContext(
  options: { uploadFails?: boolean; probeSeconds?: number | null } = {},
) {
  const uploads: Array<{ key: string; contentType: string; byteLength: number }> =
    [];
  const warnings: string[] = [];
  return {
    uploads,
    warnings,
    ctx: {
      logger: {
        info: () => undefined,
        warn: (message: string) => warnings.push(message),
        error: () => undefined,
      },
      llm: { complete: async () => "", completeStructured: async () => ({}) },
      storage: {
        buildArtifactStorageKey: ({
          artifactId,
          fileName,
          workspaceId,
        }: {
          artifactId: string;
          fileName: string;
          workspaceId: string;
        }) => `workspaces/${workspaceId}/artifacts/${artifactId}/${fileName}`,
        getBucketName: () => "content",
        download: async () => null,
        upload: async (input: {
          key: string;
          contentType: string;
          body: Uint8Array;
        }) => {
          if (options.uploadFails) {
            throw new Error("storage unavailable");
          }
          uploads.push({
            key: input.key,
            contentType: input.contentType,
            byteLength: input.body.byteLength,
          });
        },
      },
      audio: {
        probeDurationSeconds: async () =>
          options.probeSeconds === undefined ? null : options.probeSeconds,
      },
    } as never,
    api: {
      updateStageProgress: async () => undefined,
      setPreviewImage: () => undefined,
    } as never,
  };
}

async function runPublishStage(input: {
  scratch: Record<string, unknown>;
  uploadFails?: boolean;
  state?: ReturnType<typeof payloadFixture>;
}) {
  const context = stageContext(
    input.uploadFails ? { uploadFails: true } : {},
  );
  const state = await createVideoPresentationPipelineDefinition().runStage({
    stageId: "publishing_video_project",
    ctx: context.ctx,
    job,
    prepared: {},
    scratch: input.scratch,
    api: context.api,
    state: input.state ?? payloadFixture(),
  } as never);
  return { ...context, state };
}

test("the publish stage stores no mp4 even if a run carried one", async () => {
  // `video` is the old sandbox-render shape; publish must ignore it now — no
  // upload, no `renderedVideo` — because the deck is client-compiled.
  const { state, uploads } = await runPublishStage({
    scratch: {
      projectRun: {
        install: { ok: true, diagnostics: [] },
        typecheck: { ok: true, diagnostics: [] },
        smoke: { ok: true, diagnostics: [] },
        stills: [],
        video: { data: new Uint8Array([1, 2, 3, 4]), report },
      },
    },
  });
  assert.equal(state.renderedVideo, undefined);
  assert.deepEqual(uploads, []);
});

test("no render means no renderedVideo, and the deck still publishes", async () => {
  const { state, uploads } = await runPublishStage({
    scratch: {
      projectRun: {
        install: { ok: true, diagnostics: [] },
        typecheck: { ok: true, diagnostics: [] },
        smoke: { ok: true, diagnostics: [] },
        stills: [],
      },
    },
  });
  assert.equal(state.renderedVideo, undefined);
  assert.deepEqual(uploads, []);
  // The presentation itself is complete: duration is still computed.
  assert.equal(state.project.durationSeconds, 3);
});

test("a stale renderedVideo is dropped when this run produced none", async () => {
  // An edit run re-renders every scene; a previously stored mp4 describes a
  // deck that no longer exists, so carrying it forward would show the old
  // video under the new payload.
  const stale = videoPresentationProjectPayloadSchema.parse({
    ...payloadFixture(),
    renderedVideo: {
      assetUrl: "/assets/old.mp4",
      storageKey: "old.mp4",
      fileName: "old.mp4",
      mimeType: "video/mp4",
      byteLength: 10,
      durationInFrames: 60,
      fps: 30,
      width: 1920,
      height: 1080,
      hasAudio: true,
    },
  });
  const { state } = await runPublishStage({
    state: stale,
    scratch: {
      projectRun: {
        install: { ok: true, diagnostics: [] },
        typecheck: { ok: true, diagnostics: [] },
        smoke: { ok: true, diagnostics: [] },
        stills: [],
      },
    },
  });
  assert.equal(state.renderedVideo, undefined);
});

/* -------------------------------------------------------------------------- */
/* Never asking for a render                                                  */
/* -------------------------------------------------------------------------- */

/** Runs `installing_project` and reports what it asked the sandbox for. */
async function runInstallStage(input: {
  narrated: boolean;
  /** Storage answer for the narration read-back. */
  object?: Uint8Array | null;
  /** What the render-time re-probe measures on those bytes; null = cannot. */
  probeSeconds?: number | null;
}) {
  const state = input.narrated
    ? videoPresentationProjectPayloadSchema.parse({
        ...payloadFixture(),
        audioTracks: [
          {
            slideNumber: 1,
            assetUrl: "/assets/track-1.mp3",
            storageKey: "key-1",
            storageBucket: "content",
            durationSeconds: 2,
            mimeType: "audio/mpeg",
            fileName: "Quarterly-Review-slide-1.mp3",
          },
        ],
      })
    : payloadFixture();
  const context = stageContext({
    probeSeconds: input.probeSeconds === undefined ? 2 : input.probeSeconds,
  });
  const requests: Array<Record<string, unknown>> = [];
  const definition = createVideoPresentationPipelineDefinition({
    runProject: async (runInput) => {
      requests.push(runInput as never);
      return {
        install: { ok: true, diagnostics: [] },
        typecheck: { ok: true, diagnostics: [] },
        smoke: { ok: true, diagnostics: [] },
      };
    },
  });
  const ctx = {
    ...(context.ctx as unknown as Record<string, unknown>),
    storage: {
      ...(context.ctx as unknown as { storage: Record<string, unknown> })
        .storage,
      download: async () =>
        input.object ? { body: input.object, contentType: "audio/mpeg" } : null,
    },
  };
  await definition.runStage({
    stageId: "installing_project",
    ctx: ctx as never,
    job,
    prepared: {},
    scratch: {},
    api: context.api,
    state,
  } as never);
  return { request: requests[0], warnings: context.warnings };
}

test("the install stage never asks the sandbox to render an mp4", async () => {
  // The sandbox is handed the project to install/typecheck/smoke only. It is
  // never passed `renderVideo` — narrated or not — so no narration is staged
  // and no server mp4 is produced.
  const narrated = await runInstallStage({
    narrated: true,
    object: new Uint8Array([1, 2, 3]),
    probeSeconds: 2.4,
  });
  assert.equal(
    (narrated.request as { renderVideo?: unknown }).renderVideo,
    undefined,
  );
  assert.deepEqual(narrated.warnings, []);

  const silent = await runInstallStage({ narrated: false });
  assert.equal(
    (silent.request as { renderVideo?: unknown }).renderVideo,
    undefined,
  );
});

/* -------------------------------------------------------------------------- */
/* What the finished artifact claims about itself                             */
/* -------------------------------------------------------------------------- */

test("the ready payload names the strategy the artifact actually used", () => {
  const browserOnly = attachReadySourceJson({
    artifactId: "artifact-1",
    jobId: "job-1",
    payload: payloadFixture(),
    workspaceId: "workspace-1",
  });
  assert.equal(
    browserOnly.renderStrategy,
    "frontend_remotion_project_to_video",
  );
  assert.equal(browserOnly.videoDownloadOnly, true);

  const rendered = attachReadySourceJson({
    artifactId: "artifact-1",
    jobId: "job-1",
    payload: videoPresentationProjectPayloadSchema.parse({
      ...payloadFixture(),
      renderedVideo: {
        assetUrl: "/assets/Quarterly-Review.mp4",
        storageKey: "key",
        fileName: "Quarterly-Review.mp4",
        mimeType: "video/mp4",
        byteLength: 4,
        durationInFrames: 90,
        fps: 30,
        width: 1920,
        height: 1080,
        hasAudio: true,
      },
    }),
    workspaceId: "workspace-1",
  });
  assert.equal(rendered.renderStrategy, "sandbox_remotion_project_to_mp4");
  // There is a real file on the asset route now, so "download only" stops
  // being true.
  assert.equal(rendered.videoDownloadOnly, false);
  // The mp4 rides along on the source json too.
  assert.equal(
    (rendered.sourceJson as { renderedVideo?: { fileName: string } })
      .renderedVideo?.fileName,
    "Quarterly-Review.mp4",
  );
});
