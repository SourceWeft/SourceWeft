import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createArtifactViewHandlers,
  videoPresentationArtifactViewHandler,
} from "../src/artifact-view";

const handler = videoPresentationArtifactViewHandler;

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    artifactType: "video_presentation",
    status: "running",
    storageBucket: "content",
    storageKey: null,
    payloadJson: {},
    ...overrides,
  } as never;
}

test("the package contributes a handler for its own artifact type", () => {
  const handlers = createArtifactViewHandlers();
  assert.deepEqual(
    (handlers as readonly { artifactType: string }[]).map(
      (entry) => entry.artifactType,
    ),
    ["video_presentation"],
  );
});

test("audio tracks resolve by file name with their own bucket and MIME type", () => {
  const record = artifact({
    payloadJson: {
      audioTracks: [
        {
          fileName: "scene-1.mp3",
          mimeType: "audio/mpeg",
          storageBucket: "audio",
          storageKey: "w1/a1/scene-1.mp3",
        },
      ],
    },
  });

  assert.deepEqual(
    handler.resolveAsset?.({ artifact: record, fileName: "scene-1.mp3" }),
    {
      contentType: "audio/mpeg",
      fileName: "scene-1.mp3",
      storageBucket: "audio",
      storageKey: "w1/a1/scene-1.mp3",
    },
  );
  assert.equal(
    handler.resolveAsset?.({ artifact: record, fileName: "missing.mp3" }),
    null,
  );
});

test("buildPublicPayload rewrites asset URLs, blanks storage, redacts source, drops DB internals", () => {
  const record = artifact({
    status: "ready",
    payloadJson: {
      schemaVersion: 2,
      kind: "video_presentation",
      generation: { status: "ready", stage: "ready", progress: 100 },
      project: {
        title: "Deck",
        fps: 30,
        width: 1920,
        height: 1080,
        durationSeconds: 10,
        stylePreset: "cinematic",
        globalVisualDirection: "dir",
      },
      slides: [
        {
          slideNumber: 1,
          title: "S1",
          speakerTranscript: ["hi"],
          sceneIntent: "intent",
        },
      ],
      audioTracks: [
        {
          slideNumber: 1,
          assetUrl: "/v1/workspaces/ws/artifacts/a/assets/slide-1.mp3",
          storageKey: "ws/a/slide-1.mp3",
          storageBucket: "audio",
          durationSeconds: 5,
          mimeType: "audio/mpeg",
          fileName: "slide-1.mp3",
        },
      ],
      sceneModules: [],
      assets: [],
      renderProfile: {
        stylePreset: "cinematic",
        visualDensity: "balanced",
        durationTarget: "medium",
        language: "auto",
      },
      themeAssignments: [],
      sourceDigest: "SECRET SOURCE MATERIAL",
      // Non-schema DB internals the raw payload carries — must not survive.
      sourceJson: { internal: true },
      jobId: "job-123",
      renderedVideo: {
        assetUrl: "x",
        storageKey: "ws/a/video.mp4",
        fileName: "video.mp4",
        mimeType: "video/mp4",
        byteLength: 10,
        durationInFrames: 30,
        fps: 30,
        width: 1920,
        height: 1080,
      },
    },
  });

  const publicPayload = handler.buildPublicPayload?.({
    artifact: record,
    assetUrl: (fileName) => `https://api/public/shares/tok/assets/${fileName}`,
  }) as Record<string, unknown> | null | undefined;

  assert.ok(publicPayload);
  const track = (publicPayload.audioTracks as Record<string, unknown>[])[0]!;
  assert.equal(
    track.assetUrl,
    "https://api/public/shares/tok/assets/slide-1.mp3",
  );
  assert.equal(track.storageKey, "shared");
  assert.equal(track.storageBucket, undefined);
  assert.equal(publicPayload.sourceDigest, "[redacted]");
  assert.equal(publicPayload.renderedVideo, undefined);
  assert.equal("sourceJson" in publicPayload, false);
  assert.equal("jobId" in publicPayload, false);
});

test("buildPublicPayload returns null for an incomplete payload", () => {
  assert.equal(
    handler.buildPublicPayload?.({
      artifact: artifact({ payloadJson: {} }),
      assetUrl: (fileName) => fileName,
    }),
    null,
  );
});

test("scene assets fall back to the storage key basename and skip external refs", () => {
  const record = artifact({
    payloadJson: {
      assets: [
        { storageKey: "w1/a1/frame-2.png" },
        { fileName: "remote.png", storageKey: "external:https://example.com/x" },
      ],
    },
  });

  assert.deepEqual(
    handler.resolveAsset?.({ artifact: record, fileName: "frame-2.png" }),
    {
      contentType: "application/octet-stream",
      fileName: "frame-2.png",
      storageBucket: "content",
      storageKey: "w1/a1/frame-2.png",
    },
  );
  assert.equal(
    handler.resolveAsset?.({ artifact: record, fileName: "remote.png" }),
    null,
  );
});
