import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createWorkspaceRouteTestApp } from "../../../test/hono";

vi.mock("../../../shared/config", () => ({
  config: { auth: { webBaseUrl: "https://web.example" } },
}));

const mocks = vi.hoisted(() => ({
  getArtifactFile: vi.fn(),
  getArtifactAsset: vi.fn(),
  getArtifactVersionMedia: vi.fn(),
  getArtifactVersionMediaBytes: vi.fn(),
  getSessionUserId: vi.fn(),
  listArtifacts: vi.fn(),
  listArtifactSummaries: vi.fn(),
  readArtifactVersionSourceFile: vi.fn(),
  requireSession: vi.fn(),
}));

vi.mock("../../middleware/auth-session", () => ({
  getSessionUserId: mocks.getSessionUserId,
  requireSession: mocks.requireSession,
}));

vi.mock("../../../modules/artifacts", () => ({
  contentArtifactsService: {
    getArtifactFile: mocks.getArtifactFile,
    getArtifactAsset: mocks.getArtifactAsset,
    getArtifactVersionMedia: mocks.getArtifactVersionMedia,
    getArtifactVersionMediaBytes: mocks.getArtifactVersionMediaBytes,
    listArtifacts: mocks.listArtifacts,
    listArtifactSummaries: mocks.listArtifactSummaries,
    readArtifactVersionSourceFile: mocks.readArtifactVersionSourceFile,
  },
}));

vi.mock("../../../modules/sharing", () => ({
  sharingService: {},
}));

import { ContentError } from "../../../modules/content/errors";
import { registerArtifactRoutes } from "./artifacts";

const createTestApp = () => createWorkspaceRouteTestApp(registerArtifactRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockReturnValue("user-1");
  mocks.requireSession.mockResolvedValue({
    user: { id: "user-1" },
    session: { id: "session-1", userId: "user-1" },
  });
  mocks.listArtifacts.mockResolvedValue({ items: [], nextCursor: null });
  mocks.listArtifactSummaries.mockResolvedValue({
    items: [],
    nextCursor: null,
  });
  mocks.getArtifactVersionMedia.mockResolvedValue({
    media: {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      artifactType: "video_presentation",
      title: "Trusted video",
      description: null,
      durationSeconds: 10,
      media: {
        url: "/video",
        downloadUrl: "/video?download=1",
        contentType: "video/mp4",
        fileName: "trusted.mp4",
        byteLength: 10,
        width: 1920,
        height: 1080,
        fps: 30,
        hasAudio: true,
      },
      coverImage: null,
    },
  });
});

test("artifact list summary view dispatches to the bounded projection", async () => {
  const response = await createTestApp().request(
    "/v1/workspaces/workspace-1/artifacts?view=summary&limit=25&cursor=next",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(mocks.listArtifactSummaries.mock.calls[0]?.[0], {
    workspaceId: "workspace-1",
    userId: "user-1",
    limit: 25,
    cursor: "next",
  });
  assert.equal(mocks.listArtifacts.mock.calls.length, 0);
});

test("artifact list without a view preserves the compatibility response", async () => {
  const response = await createTestApp().request(
    "/v1/workspaces/workspace-1/artifacts?limit=10",
  );

  assert.equal(response.status, 200);
  assert.equal(mocks.listArtifacts.mock.calls.length, 1);
  assert.equal(mocks.listArtifactSummaries.mock.calls.length, 0);
});

test("artifact list rejects unknown projections without falling back", async () => {
  const response = await createTestApp().request(
    "/v1/workspaces/workspace-1/artifacts?view=compact",
  );

  assert.equal(response.status, 400);
  assert.equal(mocks.listArtifacts.mock.calls.length, 0);
  assert.equal(mocks.listArtifactSummaries.mock.calls.length, 0);
  assert.equal(
    ((await response.json()) as { code: string }).code,
    "VALIDATION_ERROR",
  );
});

test("artifact version media projection is resolved by exact version identity", async () => {
  const response = await createTestApp().request(
    "/v1/workspaces/workspace-1/artifacts/artifact-1/versions/version-1/media",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(mocks.getArtifactVersionMedia.mock.calls[0]?.[0], {
    workspaceId: "workspace-1",
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    userId: "user-1",
  });
  const body = (await response.json()) as {
    media?: { artifactVersionId?: string };
  };
  assert.equal(body.media?.artifactVersionId, "version-1");
});

test("artifact version video route forwards Range and returns a 206 response", async () => {
  mocks.getArtifactVersionMediaBytes.mockResolvedValueOnce({
    kind: "bytes",
    status: 206,
    body: new Uint8Array([2, 3, 4, 5]),
    contentType: "video/mp4",
    fileName: "trusted.mp4",
    etag: '"sha256-video"',
    contentLength: 4,
    totalLength: 10,
    contentRange: "bytes 2-5/10",
    download: false,
  });

  const response = await createTestApp().request(
    "/v1/workspaces/workspace-1/artifacts/artifact-1/versions/version-1/media/video",
    { headers: { Range: "bytes=2-5", "If-None-Match": '"stale"' } },
  );

  assert.equal(response.status, 206);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(response.headers.get("content-length"), "4");
  assert.equal(response.headers.get("etag"), '"sha256-video"');
  assert.equal(
    response.headers.get("cache-control"),
    "private, no-cache, max-age=0, must-revalidate",
  );
  assert.deepEqual(mocks.getArtifactVersionMediaBytes.mock.calls[0]?.[0], {
    workspaceId: "workspace-1",
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    userId: "user-1",
    resource: "video",
    range: "bytes=2-5",
    ifNoneMatch: '"stale"',
    download: false,
  });
  assert.deepEqual(
    new Uint8Array(await response.arrayBuffer()),
    new Uint8Array([2, 3, 4, 5]),
  );
});

test("artifact version media route preserves 304 without a response body", async () => {
  mocks.getArtifactVersionMediaBytes.mockResolvedValueOnce({
    kind: "not_modified",
    etag: '"sha256-video"',
  });

  const response = await createTestApp().request(
    "/v1/workspaces/workspace-1/artifacts/artifact-1/versions/version-1/media/video",
    { headers: { "If-None-Match": '"sha256-video"' } },
  );

  assert.equal(response.status, 304);
  assert.equal(response.headers.get("etag"), '"sha256-video"');
  assert.equal(await response.text(), "");
});

test("HTML file responses bind the requested version and carry the registered sandbox policy", async () => {
  mocks.getArtifactFile.mockResolvedValue({
    body: Buffer.from("<html>verified</html>"),
    contentType: "text/html",
    fileName: "index.html",
    executionPolicy: "sandboxed-html",
    renderer: "html-document",
  });
  const response = await createTestApp().request(
    "/v1/workspaces/workspace-1/artifacts/artifact-1/file?artifactVersionId=version-1",
  );
  assert.equal(response.status, 200);
  assert.equal(
    mocks.getArtifactFile.mock.calls[0]?.[0].artifactVersionId,
    "version-1",
  );
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /sandbox allow-scripts/,
  );
  assert.doesNotMatch(
    response.headers.get("content-security-policy") ?? "",
    /allow-same-origin/,
  );
  assert.equal(
    response.headers.get("x-sourceweft-artifact-execution"),
    "sandboxed-html",
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(await response.text(), "<html>verified</html>");
});

test("authenticated exact-version assets support explicit attachment downloads", async () => {
  mocks.getArtifactAsset.mockResolvedValue({
    body: Buffer.from("pdf"),
    contentType: "application/pdf",
    fileName: "report.pdf",
  });
  const response = await createTestApp().request(
    "/v1/workspaces/workspace-1/artifacts/artifact-1/assets/report.pdf?artifactVersionId=version-1&download=1",
  );
  assert.equal(response.status, 200);
  assert.equal(
    mocks.getArtifactAsset.mock.calls[0]?.[0].artifactVersionId,
    "version-1",
  );
  assert.equal(
    response.headers.get("content-disposition"),
    "attachment; filename*=UTF-8''report.pdf",
  );
  assert.equal(response.headers.get("content-type"), "application/pdf");
});

const sourceFileUrl =
  "/v1/workspaces/workspace-1/artifacts/artifact-1/versions/version-1/source-files/report.source.json";

test("member source-file route returns the exact private bytes as uncacheable JSON", async () => {
  const bytes = Buffer.from('{"sources":[{"id":"S1"}]}');
  mocks.readArtifactVersionSourceFile.mockResolvedValue({
    bytes,
    fileName: "report.source.json",
    artifactVersionId: "version-1",
    versionNo: 1,
    contentDigest: "sha256:ignored",
  });
  const response = await createTestApp().request(sourceFileUrl);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("content-length"), String(bytes.length));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("content-disposition"), null);
  assert.deepEqual(mocks.readArtifactVersionSourceFile.mock.calls[0]?.[0], {
    workspaceId: "workspace-1",
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    fileName: "report.source.json",
    userId: "user-1",
  });
});

test("member source-file route relays the service's existence-hiding 404 and integrity 409", async () => {
  mocks.readArtifactVersionSourceFile.mockRejectedValue(
    new ContentError(
      404,
      "ARTIFACT_VERSION_FILE_NOT_FOUND",
      "This version has no authorized file for this request",
    ),
  );
  let response = await createTestApp().request(sourceFileUrl);
  assert.equal(response.status, 404);
  assert.equal(
    ((await response.json()) as { code: string }).code,
    "ARTIFACT_VERSION_FILE_NOT_FOUND",
  );
  mocks.readArtifactVersionSourceFile.mockRejectedValue(
    new ContentError(
      409,
      "ARTIFACT_FILE_INTEGRITY_MISMATCH",
      "The stored file does not match its published version",
    ),
  );
  response = await createTestApp().request(sourceFileUrl);
  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as { code: string }).code,
    "ARTIFACT_FILE_INTEGRITY_MISMATCH",
  );
});

test("member source-file route requires a session before touching the service", async () => {
  mocks.requireSession.mockResolvedValue(null);
  const response = await createTestApp().request(sourceFileUrl);
  assert.equal(response.status, 401);
  assert.equal(mocks.readArtifactVersionSourceFile.mock.calls.length, 0);
});
