import assert from "node:assert/strict";
import { Hono } from "hono";
import { beforeEach, test, vi } from "vitest";
import { ApiError, ApiResponse, toApiError } from "../response/api-response";

const mocks = vi.hoisted(() => ({
  resolvePublicArtifactBytes: vi.fn(),
  getSharedArtifactVersionMediaBytes: vi.fn(),
  getSharedCurrentArtifactVersionMedia: vi.fn(),
}));

vi.mock("../../modules/sharing", () => ({
  sharingService: {
    resolvePublicArtifactBytes: mocks.resolvePublicArtifactBytes,
    resolvePublicArtifact: vi.fn(),
  },
}));

vi.mock("../../modules/artifacts", () => ({
  contentArtifactsService: {
    getSharedArtifactVersionMediaBytes:
      mocks.getSharedArtifactVersionMediaBytes,
    getSharedCurrentArtifactVersionMedia:
      mocks.getSharedCurrentArtifactVersionMedia,
  },
}));

import { registerPublicShareRoutes } from "./public-shares";

function createTestApp() {
  const app = new Hono();
  registerPublicShareRoutes(app);
  app.notFound((c) => ApiResponse.error(c, ApiError.notFound()));
  app.onError((error, c) => ApiResponse.error(c, toApiError(error)));
  return app;
}

const artifact = {
  id: "artifact-1",
  teamId: "team-1",
  workspaceId: "workspace-1",
  artifactType: "video_presentation",
  status: "ready",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolvePublicArtifactBytes.mockResolvedValue({
    artifact,
    share: { noindex: false },
  });
});

test("public version media serves bytes when the requested version is current", async () => {
  mocks.getSharedArtifactVersionMediaBytes.mockResolvedValue({
    kind: "bytes",
    status: 200,
    body: new Uint8Array([1, 2, 3]),
    contentType: "video/mp4",
    fileName: "video.mp4",
    etag: '"etag-1"',
    contentLength: 3,
    totalLength: 3,
    download: false,
  });

  const response = await createTestApp().request(
    "http://localhost/v1/public/shares/tok/versions/version-2/media/video",
  );

  assert.equal(response.status, 200);
  assert.equal(mocks.getSharedCurrentArtifactVersionMedia.mock.calls.length, 0);
});

test("public version media rejects a stale (superseded) version with a distinct, recoverable error", async () => {
  mocks.getSharedArtifactVersionMediaBytes.mockResolvedValue(null);
  mocks.getSharedCurrentArtifactVersionMedia.mockResolvedValue({
    versionId: "version-2",
    media: { media: { contentType: "video/mp4" }, coverImage: null },
  });

  const response = await createTestApp().request(
    "http://localhost/v1/public/shares/tok/versions/version-1/media/video",
  );

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.code, "ARTIFACT_VERSION_STALE");
  assert.deepEqual(body.details, { currentVersionId: "version-2" });
});

test("public version media reports a genuine miss (no current version at all) as not-found, not stale", async () => {
  mocks.getSharedArtifactVersionMediaBytes.mockResolvedValue(null);
  mocks.getSharedCurrentArtifactVersionMedia.mockResolvedValue(null);

  const response = await createTestApp().request(
    "http://localhost/v1/public/shares/tok/versions/version-1/media/video",
  );

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.code, "ARTIFACT_VERSION_MEDIA_NOT_FOUND");
});

test("public version media reports a genuine miss (matching version, no such resource) as not-found, not stale", async () => {
  mocks.getSharedArtifactVersionMediaBytes.mockResolvedValue(null);
  mocks.getSharedCurrentArtifactVersionMedia.mockResolvedValue({
    versionId: "version-1",
    media: { media: { contentType: "video/mp4" }, coverImage: null },
  });

  const response = await createTestApp().request(
    "http://localhost/v1/public/shares/tok/versions/version-1/media/cover",
  );

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.code, "ARTIFACT_VERSION_MEDIA_NOT_FOUND");
});
