import assert from "node:assert/strict";
import { Hono } from "hono";
import { beforeEach, test, vi } from "vitest";
import { ApiError, ApiResponse, toApiError } from "../../response/api-response";

vi.mock("../../../shared/config", () => ({
  config: { auth: { webBaseUrl: "https://web.example" } },
}));

const mocks = vi.hoisted(() => ({
  getArtifactFile: vi.fn(),
  getArtifactVersionMedia: vi.fn(),
  getArtifactVersionMediaBytes: vi.fn(),
  getSessionUserId: vi.fn(),
  listArtifacts: vi.fn(),
  listArtifactSummaries: vi.fn(),
  requireSession: vi.fn(),
}));

vi.mock("../../middleware/auth-session", () => ({
  getSessionUserId: mocks.getSessionUserId,
  requireSession: mocks.requireSession,
}));

vi.mock("../../../modules/artifacts", () => ({
  contentArtifactsService: {
    getArtifactFile: mocks.getArtifactFile,
    getArtifactVersionMedia: mocks.getArtifactVersionMedia,
    getArtifactVersionMediaBytes: mocks.getArtifactVersionMediaBytes,
    listArtifacts: mocks.listArtifacts,
    listArtifactSummaries: mocks.listArtifactSummaries,
  },
}));

vi.mock("../../../modules/sharing", () => ({
  sharingService: {},
}));

import { registerArtifactRoutes } from "./artifacts";

function createTestApp() {
  const app = new Hono();
  const workspaceRoutes = new Hono();
  registerArtifactRoutes(workspaceRoutes);
  app.route("/v1/workspaces/:workspaceId", workspaceRoutes);
  app.notFound((c) => ApiResponse.error(c, ApiError.notFound()));
  app.onError((error, c) => ApiResponse.error(c, toApiError(error)));
  return app;
}

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
