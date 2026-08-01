import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mockResolveAccess = vi.fn();
const mockCanAdministerContainer = vi.fn();
const mockCanAdministerContent = vi.fn();
const mockFindArtifact = vi.fn();
const mockCreateShare = vi.fn();
const mockFindActive = vi.fn();
const mockFindLive = vi.fn();
const mockIncrement = vi.fn();
const mockRevokeForThread = vi.fn();
const mockAuditRecord = vi.fn();
const mockInlineRenderable = vi.fn();

vi.mock("../workspace", () => ({
  workspaceService: {
    resolveAccess: (...a: unknown[]) => mockResolveAccess(...a),
    canAdministerContainer: (...a: unknown[]) =>
      mockCanAdministerContainer(...a),
    canAdministerContent: (...a: unknown[]) => mockCanAdministerContent(...a),
  },
}));
// The real, pure content-visibility predicate: a private artifact is visible
// only to its creator. Left unmocked so the tests exercise the actual gate.
vi.mock("../team-audit", () => ({
  teamAuditService: { record: (...a: unknown[]) => mockAuditRecord(...a) },
}));
vi.mock("../artifacts/repository", () => ({
  findArtifactRecord: (...a: unknown[]) => mockFindArtifact(...a),
}));
vi.mock("../artifacts", () => ({
  contentArtifactsService: {
    isSharedArtifactInlineRenderable: (...a: unknown[]) =>
      mockInlineRenderable(...a),
  },
}));
vi.mock("./store", () => ({
  createShareLink: (...a: unknown[]) => mockCreateShare(...a),
  findActiveShareByTarget: (...a: unknown[]) => mockFindActive(...a),
  findLiveShareByToken: (...a: unknown[]) => mockFindLive(...a),
  incrementShareViewCount: (...a: unknown[]) => mockIncrement(...a),
  revokeShareLink: vi.fn(),
  revokeShareLinksForThreadArtifacts: (...a: unknown[]) =>
    mockRevokeForThread(...a),
  updateShareLink: vi.fn(),
}));
vi.mock("../../shared/config", () => ({
  config: {
    auth: { webBaseUrl: "https://app.test", baseUrl: "https://api.test" },
  },
}));

const { sharingService } = await import("./service");

const ACCESS = {
  workspaceId: "ws-1",
  organizationId: "team-1",
  userId: "actor",
  organizationRole: "member",
  role: "editor",
  source: "derived",
  isContainerAdmin: false,
};

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    id: "art-1",
    teamId: "team-1",
    workspaceId: "ws-1",
    artifactType: "report",
    status: "ready",
    title: "Q3",
    payloadJson: {},
    storageKey: "k",
    storageBucket: "b",
    previewStorageKey: null,
    visibility: "workspace",
    createdBy: "author",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveAccess.mockResolvedValue(ACCESS);
  mockCanAdministerContainer.mockReturnValue(false);
  mockCanAdministerContent.mockReturnValue(false);
  mockInlineRenderable.mockResolvedValue(true);
});

test("the artifact's creator may share it", async () => {
  mockFindArtifact.mockResolvedValue(artifact({ createdBy: "actor" }));
  mockFindActive.mockResolvedValue(null);
  mockCreateShare.mockResolvedValue({
    token: "tok",
    targetType: "artifact",
    targetId: "art-1",
    isPublic: true,
    noindex: false,
    accessLevel: "viewer",
    viewCount: 0,
    expiresAt: null,
    createdAt: new Date(0),
  });

  const result = await sharingService.shareArtifact({
    workspaceId: "ws-1",
    artifactId: "art-1",
    userId: "actor",
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.url, "https://app.test/artifact/tok");
});

test("a non-creator without container admin cannot share", async () => {
  mockFindArtifact.mockResolvedValue(artifact({ createdBy: "someone-else" }));
  mockCanAdministerContainer.mockReturnValue(false);

  const result = await sharingService.shareArtifact({
    workspaceId: "ws-1",
    artifactId: "art-1",
    userId: "actor",
  });

  assert.deepEqual(result, { ok: false, reason: "forbidden" });
});

test("a content workspace admin may share another member's workspace artifact", async () => {
  mockFindArtifact.mockResolvedValue(
    artifact({ createdBy: "someone-else", visibility: "workspace" }),
  );
  mockCanAdministerContent.mockReturnValue(true);
  mockFindActive.mockResolvedValue(null);
  mockCreateShare.mockResolvedValue({
    token: "tok",
    targetType: "artifact",
    targetId: "art-1",
    isPublic: true,
    noindex: false,
    accessLevel: "viewer",
    viewCount: 0,
    expiresAt: null,
    createdAt: new Date(0),
  });

  const result = await sharingService.shareArtifact({
    workspaceId: "ws-1",
    artifactId: "art-1",
    userId: "actor",
  });

  assert.equal(result.ok, true);
});

test("a workspace admin cannot share another member's PRIVATE artifact — reported not_found", async () => {
  // Two-plane rule: even a content admin may only change the exposure of
  // something they can view. A private artifact of another member is invisible
  // to them, so its very existence stays hidden.
  mockFindArtifact.mockResolvedValue(
    artifact({ createdBy: "someone-else", visibility: "private" }),
  );
  mockCanAdministerContent.mockReturnValue(true);

  const result = await sharingService.shareArtifact({
    workspaceId: "ws-1",
    artifactId: "art-1",
    userId: "actor",
  });

  assert.deepEqual(result, { ok: false, reason: "not_found" });
});

test("an org owner who joined as a viewer cannot share another member's artifact", async () => {
  // Container-plane standing (org owner / container admin) confers no publish
  // right over content. As a plain content viewer, canAdministerContent is
  // false → forbidden, even though canAdministerContainer would be true.
  mockFindArtifact.mockResolvedValue(
    artifact({ createdBy: "someone-else", visibility: "workspace" }),
  );
  mockCanAdministerContainer.mockReturnValue(true);
  mockCanAdministerContent.mockReturnValue(false);

  const result = await sharingService.shareArtifact({
    workspaceId: "ws-1",
    artifactId: "art-1",
    userId: "actor",
  });

  assert.deepEqual(result, { ok: false, reason: "forbidden" });
});

test("a plain viewer cannot share another member's artifact", async () => {
  mockFindArtifact.mockResolvedValue(
    artifact({ createdBy: "someone-else", visibility: "workspace" }),
  );
  mockCanAdministerContent.mockReturnValue(false);

  const result = await sharingService.shareArtifact({
    workspaceId: "ws-1",
    artifactId: "art-1",
    userId: "actor",
  });

  assert.deepEqual(result, { ok: false, reason: "forbidden" });
});

test("a non-member gets not_found, never revealing the artifact exists", async () => {
  mockResolveAccess.mockResolvedValue(null);

  const result = await sharingService.shareArtifact({
    workspaceId: "ws-1",
    artifactId: "art-1",
    userId: "outsider",
  });

  assert.deepEqual(result, { ok: false, reason: "not_found" });
});

test("public resolve returns null for a revoked/expired/unknown token", async () => {
  // findLiveShareByToken already filters revoked/expired, so a null row here
  // stands in for all three cases.
  mockFindLive.mockResolvedValue(null);
  assert.equal(await sharingService.resolvePublicArtifact("nope"), null);
});

test("public resolve rejects a non-artifact or non-public share", async () => {
  mockFindLive.mockResolvedValue({
    targetType: "thread",
    isPublic: true,
    teamId: "team-1",
    workspaceId: "ws-1",
    targetId: "t-1",
    viewCount: 0,
    noindex: false,
    createdAt: new Date(0),
  });
  assert.equal(await sharingService.resolvePublicArtifact("tok"), null);
});

const LIVE_ARTIFACT_SHARE = {
  targetType: "artifact",
  isPublic: true,
  teamId: "team-1",
  workspaceId: "ws-1",
  targetId: "art-1",
  token: "tok",
  viewCount: 41,
  noindex: false,
  createdAt: new Date(0),
};

test("public resolve projects a ready artifact without counting a view", async () => {
  // The projection is fetched twice per page load (metadata + render), so it
  // must not count — the byte serve does.
  mockFindLive.mockResolvedValue(LIVE_ARTIFACT_SHARE);
  mockFindArtifact.mockResolvedValue(artifact());

  const projection = await sharingService.resolvePublicArtifact("tok");

  assert.equal(projection?.artifactType, "report");
  assert.equal(
    projection?.fileUrl,
    "https://api.test/v1/public/shares/tok/raw",
  );
  assert.equal(projection?.viewCount, 41);
  assert.equal(mockIncrement.mock.calls.length, 0);
});

test("public projection carries the inline-previewable flag for the renderer", async () => {
  // A non-embeddable file (e.g. a .pptx deck) must report false so the page
  // falls back to the poster image instead of a blank iframe.
  mockFindLive.mockResolvedValue(LIVE_ARTIFACT_SHARE);
  mockFindArtifact.mockResolvedValue(artifact());
  mockInlineRenderable.mockResolvedValue(false);

  const projection = await sharingService.resolvePublicArtifact("tok");
  assert.equal(projection?.inlinePreviewable, false);
  assert.equal(mockInlineRenderable.mock.calls.length, 1);
});

test("public resolve serves an explicitly-shared artifact even from a private thread", async () => {
  // A live public share IS the deliberate public grant; the artifact's
  // workspace `visibility` is an orthogonal axis. Exposure is withdrawn by
  // revoking the share (privating a thread revokes first — covered below), so a
  // still-live share on a `private` artifact means it was deliberately published
  // from a private thread, which we honor rather than blank.
  mockFindLive.mockResolvedValue(LIVE_ARTIFACT_SHARE);
  mockFindArtifact.mockResolvedValue(artifact({ visibility: "private" }));

  const projection = await sharingService.resolvePublicArtifact("tok");
  assert.equal(projection?.artifactType, "report");

  mockFindLive.mockResolvedValue(LIVE_ARTIFACT_SHARE);
  mockFindArtifact.mockResolvedValue(artifact({ visibility: "private" }));
  mockIncrement.mockResolvedValue(undefined);
  const bytes = await sharingService.resolvePublicArtifactBytes("tok", {
    countView: true,
  });
  assert.ok(bytes);
  assert.equal(bytes?.artifact.visibility, "private");
  assert.equal(mockIncrement.mock.calls.length, 1);
});

test("public resolve still refuses a not-ready artifact with a live share", async () => {
  // Visibility no longer gates, but a share pointing at bytes that don't exist
  // yet (or failed) must not serve.
  mockFindLive.mockResolvedValue(LIVE_ARTIFACT_SHARE);
  mockFindArtifact.mockResolvedValue(artifact({ status: "pending" }));

  assert.equal(await sharingService.resolvePublicArtifact("tok"), null);

  mockFindLive.mockResolvedValue(LIVE_ARTIFACT_SHARE);
  mockFindArtifact.mockResolvedValue(artifact({ status: "pending" }));
  assert.equal(
    await sharingService.resolvePublicArtifactBytes("tok", { countView: true }),
    null,
  );
  assert.equal(mockIncrement.mock.calls.length, 0);
});

test("public projection leaks no internal payload fields", async () => {
  // A realistic payload embeds workspace-scoped URLs, a job id, source JSON,
  // and storage keys/buckets — all internal. None may cross the public boundary.
  mockFindLive.mockResolvedValue(LIVE_ARTIFACT_SHARE);
  mockFindArtifact.mockResolvedValue(
    artifact({
      payloadJson: {
        jobId: "job-secret",
        sourceJson: { slides: ["internal"] },
        sourceJsonStorageKey: "keys/deck.source.json",
        sourceJsonStorageBucket: "internal-bucket",
        fileUrl: "https://api.test/v1/workspaces/ws-1/artifacts/art-1/file",
      },
    }),
  );

  const projection = await sharingService.resolvePublicArtifact("tok");
  assert.ok(projection);

  const serialized = JSON.stringify(projection);
  for (const needle of [
    "payloadJson",
    "workspaceId",
    "artifactId",
    "jobId",
    "job-secret",
    "sourceJson",
    "StorageKey",
    "StorageBucket",
    "/v1/workspaces/",
    "ws-1",
  ]) {
    assert.ok(
      !serialized.includes(needle),
      `public projection must not contain "${needle}": ${serialized}`,
    );
  }
});

test("serving the bytes counts a view only when asked", async () => {
  mockFindLive.mockResolvedValue(LIVE_ARTIFACT_SHARE);
  mockFindArtifact.mockResolvedValue(artifact());
  mockIncrement.mockResolvedValue(undefined);

  await sharingService.resolvePublicArtifactBytes("tok");
  assert.equal(mockIncrement.mock.calls.length, 0);

  await sharingService.resolvePublicArtifactBytes("tok", { countView: true });
  assert.equal(mockIncrement.mock.calls.length, 1);
});

test("privating a thread revokes its artifact shares and audits each", async () => {
  mockRevokeForThread.mockResolvedValue(["art-1", "art-2"]);

  const count = await sharingService.revokeSharesForPrivatedThread({
    teamId: "team-1",
    workspaceId: "ws-1",
    threadId: "thread-1",
    actorUserId: "actor",
  });

  assert.equal(count, 2);
  assert.deepEqual(mockRevokeForThread.mock.calls[0]?.[0], {
    teamId: "team-1",
    workspaceId: "ws-1",
    threadId: "thread-1",
  });
  assert.equal(mockAuditRecord.mock.calls.length, 2);
  assert.deepEqual(mockAuditRecord.mock.calls[0]?.[0], {
    teamId: "team-1",
    actorUserId: "actor",
    action: "artifact.share_revoked",
    targetType: "artifact",
    targetId: "art-1",
    metadata: { reason: "thread_visibility_private" },
  });
});

test("privating a thread with no live shares audits nothing", async () => {
  mockRevokeForThread.mockResolvedValue([]);

  const count = await sharingService.revokeSharesForPrivatedThread({
    teamId: "team-1",
    workspaceId: "ws-1",
    threadId: "thread-1",
    actorUserId: "actor",
  });

  assert.equal(count, 0);
  assert.equal(mockAuditRecord.mock.calls.length, 0);
});
