import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VIDEO_PRESENTATION_WORKFLOW_VERSION,
  videoPresentationCommittedPayloadSchema,
} from "@sourceweft/contracts/video-presentation";
import {
  createArtifactViewHandlers,
  videoPresentationArtifactViewHandler,
} from "../src/artifact-view";

const handler = videoPresentationArtifactViewHandler;
const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;

function committedPayload() {
  return videoPresentationCommittedPayloadSchema.parse({
    schemaVersion: 1,
    kind: "video_presentation",
    requestKey: "request-1",
    workflowVersion: VIDEO_PRESENTATION_WORKFLOW_VERSION,
    builderVersion: "remotion-project",
    narrationPolicy: { enabled: false },
    project: {
      title: "Trusted video",
      fps: 30,
      width: 1920,
      height: 1080,
      durationSeconds: 5,
      stylePreset: "technical",
      globalVisualDirection: "Clear diagrams",
    },
    slides: [
      {
        slideNumber: 1,
        title: "One",
        speakerTranscript: ["One"],
        sceneIntent: "Show one",
      },
    ],
    audioTracks: [],
    sceneModules: [
      {
        slideNumber: 1,
        title: "One",
        code: "export default function VideoScene(){ return null; }",
        durationInFrames: 150,
        compileStatus: "compiled",
      },
    ],
    assets: [],
    preview: { slideCount: 1, durationSeconds: 5 },
    renderedVideo: {
      assetUrl: "/video",
      storageKey: "workspaces/ws-1/artifacts/artifact-1/video.mp4",
      storageBucket: "content",
      fileName: "video.mp4",
      mimeType: "video/mp4",
      byteLength: 1024,
      contentDigest: digest("a"),
      durationInFrames: 150,
      fps: 30,
      width: 1920,
      height: 1080,
      hasAudio: false,
    },
    coverImage: {
      assetUrl: "/cover",
      storageKey: "workspaces/ws-1/artifacts/artifact-1/cover.jpg",
      storageBucket: "content",
      fileName: "cover.jpg",
      mimeType: "image/jpeg",
      byteLength: 128,
      contentDigest: digest("b"),
      width: 1920,
      height: 1080,
      slideNumber: 1,
      metadata: { altText: "Trusted cover" },
    },
    renderProfile: {
      stylePreset: "technical",
      visualDensity: "balanced",
      durationTarget: "short",
      language: "en",
    },
    themeAssignments: [],
    sourceDigest: "source",
    projectCode: {
      install: { ok: true, diagnostics: [] },
      typecheck: { ok: true, diagnostics: [] },
      smoke: { checked: true, ok: true, diagnostics: [] },
    },
  });
}

function artifact(payloadJson: unknown = committedPayload()) {
  return {
    artifactType: "video_presentation",
    status: "ready",
    title: "Mutable title",
    storageBucket: "content",
    storageKey: null,
    payloadJson,
  };
}

test("the package contributes a handler for its artifact type", async () => {
  const handlers = await createArtifactViewHandlers();
  assert.deepEqual(
    handlers.map((entry) => entry.artifactType),
    ["video_presentation"],
  );
});

test("exact-version media resolves immutable MP4 and cover facts", () => {
  assert.deepEqual(handler.resolveVersionMedia?.({ artifact: artifact() }), {
    title: "Trusted video",
    description: null,
    durationSeconds: 5,
    media: {
      contentType: "video/mp4",
      fileName: "video.mp4",
      storageBucket: "content",
      storageKey: "workspaces/ws-1/artifacts/artifact-1/video.mp4",
      byteLength: 1024,
      contentDigest: digest("a"),
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: false,
    },
    coverImage: {
      contentType: "image/jpeg",
      fileName: "cover.jpg",
      storageBucket: "content",
      storageKey: "workspaces/ws-1/artifacts/artifact-1/cover.jpg",
      byteLength: 128,
      contentDigest: digest("b"),
      width: 1920,
      height: 1080,
    },
  });
});

test("media resolution fails closed and public shares receive no scene payload", () => {
  assert.equal(
    handler.resolveVersionMedia?.({
      artifact: artifact({ sceneModules: [{ code: "unsafe" }] }),
    }),
    null,
  );
  assert.equal(handler.buildPublicPayload, undefined);
});

test("authorized source JSON retains the canonical project for editing", () => {
  const source = handler.buildSourceJson?.({ artifact: artifact() });
  assert.equal(source?.fileName, "Trusted-video.video-presentation.json");
  assert.equal(
    (source?.payload.sceneModules as Array<{ code?: string }>)[0]?.code,
    "export default function VideoScene(){ return null; }",
  );
});

test("deletion enumeration preserves each persisted object bucket", () => {
  assert.deepEqual(
    handler.listOwnedStorageObjects?.({ artifact: artifact() }),
    [
      {
        storageBucket: "content",
        storageKey: "workspaces/ws-1/artifacts/artifact-1/video.mp4",
      },
      {
        storageBucket: "content",
        storageKey: "workspaces/ws-1/artifacts/artifact-1/cover.jpg",
      },
    ],
  );
});
