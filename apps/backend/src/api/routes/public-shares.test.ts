import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createRouteTestApp } from "../../test/hono";

const mocks = vi.hoisted(() => ({
  resolvePublicArtifactBytes: vi.fn(),
  getSharedArtifactFile: vi.fn(),
  getSharedVersionFile: vi.fn(),
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
    getSharedArtifactFile: mocks.getSharedArtifactFile,
    getSharedVersionFile: mocks.getSharedVersionFile,
    getSharedArtifactVersionMediaBytes:
      mocks.getSharedArtifactVersionMediaBytes,
    getSharedCurrentArtifactVersionMedia:
      mocks.getSharedCurrentArtifactVersionMedia,
  },
}));

import { securityHeadersMiddleware } from "../middleware/security-headers";
import { registerPublicShareRoutes } from "./public-shares";

const createTestApp = () => createRouteTestApp(registerPublicShareRoutes);

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

test("raw share bytes keep their own CSP and referrer policy under the global security headers", async () => {
  mocks.getSharedArtifactFile.mockResolvedValue({
    body: "<p>shared</p>",
    contentType: "text/html; charset=utf-8",
    fileName: "index.html",
    executionPolicy: null,
  });
  const app = createRouteTestApp((app) => {
    app.use("*", securityHeadersMiddleware);
    registerPublicShareRoutes(app);
  });

  const response = await app.request(
    "http://localhost/v1/public/shares/tok/raw",
  );

  assert.equal(response.status, 200);
  // The route's allow-list (self plus the web origin) survives; a global
  // framing header would block the cross-origin share page.
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'self' \S+/,
  );
  assert.equal(response.headers.get("x-frame-options"), null);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    response.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains",
  );
});

test("public exact-version asset downloads retain live-share authorization", async () => {
  mocks.getSharedVersionFile.mockResolvedValue({
    body: Buffer.from("pdf"),
    contentType: "application/pdf",
    fileName: "report.pdf",
  });
  const response = await createTestApp().request(
    "/v1/public/shares/tok/assets/report.pdf?artifactVersionId=version-1&download=1",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(mocks.getSharedVersionFile.mock.calls[0], [
    artifact,
    "version-1",
    { kind: "asset", fileName: "report.pdf" },
  ]);
  assert.equal(
    response.headers.get("content-disposition"),
    "attachment; filename*=UTF-8''report.pdf",
  );
  mocks.resolvePublicArtifactBytes.mockResolvedValue(null);
  mocks.getSharedVersionFile.mockClear();
  assert.equal(
    (
      await createTestApp().request(
        "/v1/public/shares/tok/assets/report.pdf?artifactVersionId=version-1&download=1",
      )
    ).status,
    404,
  );
  assert.equal(mocks.getSharedVersionFile.mock.calls.length, 0);
});
