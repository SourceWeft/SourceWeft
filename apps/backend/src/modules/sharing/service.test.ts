import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mockResolveAccess = vi.fn();
const mockCanAdministerContainer = vi.fn();
const mockFindArtifact = vi.fn();
const mockCreateShare = vi.fn();
const mockFindActive = vi.fn();
const mockFindLive = vi.fn();
const mockIncrement = vi.fn();

vi.mock("../workspace", () => ({
  workspaceService: {
    resolveAccess: (...a: unknown[]) => mockResolveAccess(...a),
    canAdministerContainer: (...a: unknown[]) =>
      mockCanAdministerContainer(...a),
  },
}));
vi.mock("../team-audit", () => ({
  teamAuditService: { record: vi.fn() },
}));
vi.mock("../artifacts/repository", () => ({
  findArtifactRecord: (...a: unknown[]) => mockFindArtifact(...a),
}));
vi.mock("./store", () => ({
  createShareLink: (...a: unknown[]) => mockCreateShare(...a),
  findActiveShareByTarget: (...a: unknown[]) => mockFindActive(...a),
  findLiveShareByToken: (...a: unknown[]) => mockFindLive(...a),
  incrementShareViewCount: (...a: unknown[]) => mockIncrement(...a),
  revokeShareLink: vi.fn(),
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
    createdBy: "author",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveAccess.mockResolvedValue(ACCESS);
  mockCanAdministerContainer.mockReturnValue(false);
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
  assert.equal(result.ok && result.value.url, "https://app.test/s/tok");
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

test("a container admin may share someone else's artifact", async () => {
  mockFindArtifact.mockResolvedValue(artifact({ createdBy: "someone-else" }));
  mockCanAdministerContainer.mockReturnValue(true);
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

test("serving the bytes counts a view only when asked", async () => {
  mockFindLive.mockResolvedValue(LIVE_ARTIFACT_SHARE);
  mockFindArtifact.mockResolvedValue(artifact());
  mockIncrement.mockResolvedValue(undefined);

  await sharingService.resolvePublicArtifactBytes("tok");
  assert.equal(mockIncrement.mock.calls.length, 0);

  await sharingService.resolvePublicArtifactBytes("tok", { countView: true });
  assert.equal(mockIncrement.mock.calls.length, 1);
});
