import assert from "node:assert/strict";
import test from "node:test";
import { artifactVersionMediaProjectionSchema } from "../src/artifacts";

function projection() {
  return {
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    artifactType: "video_presentation",
    title: "Trusted video",
    description: "A rendered presentation",
    durationSeconds: 12,
    media: {
      url: "/v1/workspaces/ws-1/artifacts/artifact-1/versions/version-1/media/video",
      downloadUrl:
        "/v1/workspaces/ws-1/artifacts/artifact-1/versions/version-1/media/video?download=1",
      contentType: "video/mp4",
      fileName: "trusted-video.mp4",
      byteLength: 1024,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
    },
    coverImage: {
      url: "/v1/workspaces/ws-1/artifacts/artifact-1/versions/version-1/media/cover",
      contentType: "image/jpeg",
      fileName: "cover.jpg",
      byteLength: 128,
      width: 1920,
      height: 1080,
    },
  };
}

test("artifact-version media projection carries only browser-safe metadata and URLs", () => {
  assert.deepEqual(
    artifactVersionMediaProjectionSchema.parse(projection()),
    projection(),
  );
});

test("artifact-version media projection rejects storage coordinates and scene source", () => {
  assert.equal(
    artifactVersionMediaProjectionSchema.safeParse({
      ...projection(),
      storageKey: "workspaces/ws-1/artifacts/artifact-1/private.mp4",
    }).success,
    false,
  );
  assert.equal(
    artifactVersionMediaProjectionSchema.safeParse({
      ...projection(),
      sceneModules: [{ code: "export const VideoScene = () => null" }],
    }).success,
    false,
  );
});
