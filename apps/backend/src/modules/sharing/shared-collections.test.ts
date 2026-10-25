import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mockResolveAccess = vi.fn();
const mockCanAdministerContent = vi.fn();
const mockFindArtifact = vi.fn();
const mockListCollections = vi.fn();

vi.mock("../workspace", () => ({
  workspaceService: {
    resolveAccess: (...a: unknown[]) => mockResolveAccess(...a),
    canAdministerContent: (...a: unknown[]) => mockCanAdministerContent(...a),
  },
}));
vi.mock("../team-audit", () => ({ teamAuditService: { record: vi.fn() } }));
vi.mock("../artifacts/repository", () => ({
  findArtifactRecord: (...a: unknown[]) => mockFindArtifact(...a),
}));
vi.mock("../artifacts", () => ({ contentArtifactsService: {} }));
vi.mock("./store", () => ({}));
vi.mock("../artifact-records/shared-collections", () => ({
  listSharedCollections: (...a: unknown[]) => mockListCollections(...a),
}));
vi.mock("../../shared/config", () => ({
  config: {
    auth: { webBaseUrl: "https://app.test", baseUrl: "https://api.test" },
  },
}));

const { listArtifactShareCollections } = await import("./shared-collections");

const COLLECTIONS = [{ collection: "posts", count: 2 }];
const input = { workspaceId: "ws-1", artifactId: "art-1", userId: "actor" };

function access(role: string | null) {
  return {
    workspaceId: "ws-1",
    organizationId: "team-1",
    userId: "actor",
    organizationRole: "member",
    role,
    source: "derived",
    isContainerAdmin: false,
  };
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    id: "art-1",
    teamId: "team-1",
    workspaceId: "ws-1",
    visibility: "workspace",
    createdBy: "author",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveAccess.mockResolvedValue(access("editor"));
  mockCanAdministerContent.mockReturnValue(false);
  mockListCollections.mockResolvedValue(COLLECTIONS);
});

test("the creator lists their artifact's collections", async () => {
  mockFindArtifact.mockResolvedValue(artifact({ createdBy: "actor" }));
  const result = await listArtifactShareCollections(input);
  assert.deepEqual(result, { ok: true, value: COLLECTIONS });
  assert.deepEqual(mockListCollections.mock.calls[0], ["art-1"]);
});

test("a content admin who can view the artifact may list it", async () => {
  mockCanAdministerContent.mockReturnValue(true);
  mockFindArtifact.mockResolvedValue(artifact());
  const result = await listArtifactShareCollections(input);
  assert.equal(result.ok, true);
});

test("a plain editor who did not create the artifact is forbidden", async () => {
  mockFindArtifact.mockResolvedValue(artifact());
  const result = await listArtifactShareCollections(input);
  assert.deepEqual(result, { ok: false, reason: "forbidden" });
  assert.equal(mockListCollections.mock.calls.length, 0);
});

test("a viewer who did not create the artifact is forbidden", async () => {
  mockResolveAccess.mockResolvedValue(access("viewer"));
  mockFindArtifact.mockResolvedValue(artifact());
  const result = await listArtifactShareCollections(input);
  assert.deepEqual(result, { ok: false, reason: "forbidden" });
  assert.equal(mockListCollections.mock.calls.length, 0);
});

test("another member's private artifact is not found, even for a content admin", async () => {
  mockCanAdministerContent.mockReturnValue(true);
  mockFindArtifact.mockResolvedValue(artifact({ visibility: "private" }));
  const result = await listArtifactShareCollections(input);
  assert.deepEqual(result, { ok: false, reason: "not_found" });
  assert.equal(mockListCollections.mock.calls.length, 0);
});

test("a non-member or a missing artifact is not found", async () => {
  mockResolveAccess.mockResolvedValue(null);
  assert.deepEqual(await listArtifactShareCollections(input), {
    ok: false,
    reason: "not_found",
  });
  mockResolveAccess.mockResolvedValue(access("editor"));
  mockFindArtifact.mockResolvedValue(null);
  assert.deepEqual(await listArtifactShareCollections(input), {
    ok: false,
    reason: "not_found",
  });
});
