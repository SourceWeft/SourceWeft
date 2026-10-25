import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createRouteTestApp } from "../../test/hono";

const mocks = vi.hoisted(() => ({
  resolvePublicArtifactBytes: vi.fn(),
  getSharedArtifactFile: vi.fn(),
  getSharedVersionFile: vi.fn(),
  getSharedArtifactVersionMediaBytes: vi.fn(),
  getSharedCurrentArtifactVersionMedia: vi.fn(),
  executePublic: vi.fn(),
}));

vi.mock("../../modules/artifact-records", async () => {
  const { ContentError } = await import("../../modules/content/errors");
  return {
    artifactRecordsService: { executePublic: mocks.executePublic },
    artifactRecordError: (code: string, message: string) =>
      new ContentError(400, `ARTIFACT_RECORD_${code.toUpperCase()}`, message),
  };
});

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

import { ContentError } from "../../modules/content/errors";
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

test("share tokens never reach private authoring sources, even for the live version", async () => {
  // The member-only source-file reader lives on the workspace artifact routes
  // and must not be mirrored here; a share token gets the generic 404 and no
  // artifact service method runs.
  for (const path of [
    "/v1/public/shares/tok/versions/version-1/source-files/report.source.json",
    "/v1/public/shares/tok/source-files/report.source.json",
    "/v1/public/shares/tok/assets/report.source.json?artifactVersionId=version-1",
  ]) {
    mocks.getSharedVersionFile.mockRejectedValue(
      new ContentError(
        404,
        "ARTIFACT_VERSION_FILE_NOT_FOUND",
        "This version has no authorized file for this request",
      ),
    );
    const response = await createTestApp().request(`http://localhost${path}`);
    assert.equal(response.status, 404, path);
  }
  assert.equal(mocks.getSharedArtifactFile.mock.calls.length, 0);
  assert.equal(mocks.getSharedArtifactVersionMediaBytes.mock.calls.length, 0);
  // Only the asset path is a real route; its selector refuses source files.
  assert.equal(mocks.getSharedVersionFile.mock.calls.length, 1);
  assert.deepEqual(mocks.getSharedVersionFile.mock.calls[0]?.[2], {
    kind: "asset",
    fileName: "report.source.json",
  });
});

test("public records are read with the token and a client key, never a session", async () => {
  mocks.executePublic.mockResolvedValue({ op: "get", record: null });
  const response = await createTestApp().request(
    "http://localhost/v1/public/shares/tok/records",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "better-auth.session_token=signed-in",
        "x-real-ip": "203.0.113.9",
      },
      body: JSON.stringify({
        operation: {
          op: "get",
          scope: "shared",
          collection: "scores",
          id: "a",
        },
      }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(mocks.executePublic.mock.calls[0]![0], {
    token: "tok",
    clientKey: "203.0.113.9",
    operation: { op: "get", scope: "shared", collection: "scores", id: "a" },
  });
  const invalid = await createTestApp().request(
    "http://localhost/v1/public/shares/tok/records",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: { op: "get", collection: "x" } }),
    },
  );
  assert.equal(invalid.status, 400);
  assert.equal(mocks.executePublic.mock.calls.length, 1);
});

test("the raw route injects the runtime only for the render request", async () => {
  const html = Buffer.from(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>x</body></html>',
  );
  mocks.getSharedArtifactFile.mockResolvedValue({
    body: html,
    contentType: "text/html; charset=utf-8",
    fileName: "index.html",
    executionPolicy: "sandboxed-html",
    recordCapabilities: { storage: true, shared: true },
  });
  const read = async (query: string) =>
    (
      await createTestApp().request(
        `http://localhost/v1/public/shares/tok/raw${query}`,
      )
    ).text();
  const rendered = await read("?runtime=1");
  assert.match(rendered, /<html lang="en"><script data-sourceweft-runtime>/);
  assert.match(rendered, /"storage":true/);
  assert.equal(await read(""), html.toString());
  assert.equal(await read("?runtime=1&download=1"), html.toString());
});
