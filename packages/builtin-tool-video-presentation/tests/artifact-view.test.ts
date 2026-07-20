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
