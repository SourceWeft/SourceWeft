import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { contentArtifactsService } from "./service";
import { ContentError } from "../content/errors";
import { workspaceService } from "../workspace";
import { revokeShareLink } from "../sharing/store";
import { teamAuditService } from "../team-audit";
import { deleteArtifactObject } from "../sources/storage";
import { deleteArtifactRecord, findArtifactRecord } from "./repository";

vi.mock("../workspace/guards", () => ({
  requireContentWorkspace: vi.fn(),
}));

vi.mock("../workspace", () => ({
  workspaceService: {
    resolveAccess: vi.fn(),
    canAdministerContainer: vi.fn(),
  },
}));

vi.mock("../sources/storage", () => ({
  downloadArtifactObject: vi.fn(),
  deleteArtifactObject: vi.fn(),
}));

vi.mock("../sharing/store", () => ({
  revokeShareLink: vi.fn(),
}));

vi.mock("../team-audit", () => ({
  teamAuditService: { record: vi.fn() },
}));

vi.mock("./repository", () => ({
  deleteArtifactRecord: vi.fn(),
  findArtifactRecord: vi.fn(),
  listArtifactRecords: vi.fn(),
}));

const resolveAccess = vi.mocked(workspaceService.resolveAccess);
const canAdministerContainer = vi.mocked(
  workspaceService.canAdministerContainer,
);
const mockedFindArtifact = vi.mocked(findArtifactRecord);
const mockedDeleteRecord = vi.mocked(deleteArtifactRecord);
const mockedRevokeShare = vi.mocked(revokeShareLink);
const mockedDeleteObject = vi.mocked(deleteArtifactObject);
const mockedAudit = vi.mocked(teamAuditService.record);

const WORKSPACE_ID = "ws-1";
const TEAM_ID = "team-1";
const ARTIFACT_ID = "artifact-1";
const CREATOR_ID = "user-creator";

function memberAccess() {
  return { organizationId: TEAM_ID, role: "member" } as never;
}

function artifactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ARTIFACT_ID,
    teamId: TEAM_ID,
    workspaceId: WORKSPACE_ID,
    artifactType: "video_presentation",
    status: "failed",
    title: "费曼学习法",
    visibility: "workspace",
    createdBy: CREATOR_ID,
    storageBucket: "bucket-a",
    storageKey: "workspaces/ws-1/artifacts/artifact-1/file.mp4",
    previewStorageKey: "workspaces/ws-1/artifacts/artifact-1/preview.jpg",
    payloadJson: {
      sourceJsonStorageKey: "workspaces/ws-1/artifacts/artifact-1/deck.json",
    },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRevokeShare.mockResolvedValue(true);
  mockedDeleteRecord.mockResolvedValue(true);
  mockedDeleteObject.mockResolvedValue(undefined);
  mockedAudit.mockResolvedValue(undefined as never);
});

test("creator delete revokes the share, deletes the row, then the stored bytes", async () => {
  resolveAccess.mockResolvedValue(memberAccess());
  mockedFindArtifact.mockResolvedValue(artifactRow());

  const result = await contentArtifactsService.deleteArtifact({
    workspaceId: WORKSPACE_ID,
    artifactId: ARTIFACT_ID,
    userId: CREATOR_ID,
  });

  assert.deepEqual(result, { deleted: true, artifactId: ARTIFACT_ID });
  assert.deepEqual(mockedRevokeShare.mock.calls[0]?.[0], {
    targetType: "artifact",
    targetId: ARTIFACT_ID,
  });
  assert.deepEqual(mockedDeleteRecord.mock.calls[0]?.[0], {
    teamId: TEAM_ID,
    workspaceId: WORKSPACE_ID,
    artifactId: ARTIFACT_ID,
  });
  // Share revocation must land before the row goes: the public URL is the
  // first thing that has to stop resolving.
  assert.ok(
    mockedRevokeShare.mock.invocationCallOrder[0]! <
      mockedDeleteRecord.mock.invocationCallOrder[0]!,
  );
  assert.deepEqual(
    mockedDeleteObject.mock.calls.map((call) => call[0].key).sort(),
    [
      "workspaces/ws-1/artifacts/artifact-1/deck.json",
      "workspaces/ws-1/artifacts/artifact-1/file.mp4",
      "workspaces/ws-1/artifacts/artifact-1/preview.jpg",
    ],
  );
  assert.equal(mockedAudit.mock.calls[0]?.[0]?.action, "artifact.deleted");
});

test("a non-creator member without admin standing is refused", async () => {
  resolveAccess.mockResolvedValue(memberAccess());
  canAdministerContainer.mockReturnValue(false);
  mockedFindArtifact.mockResolvedValue(artifactRow());

  await assert.rejects(
    contentArtifactsService.deleteArtifact({
      workspaceId: WORKSPACE_ID,
      artifactId: ARTIFACT_ID,
      userId: "user-other",
    }),
    (error: unknown) =>
      error instanceof ContentError &&
      error.code === "ARTIFACT_DELETE_FORBIDDEN",
  );
  assert.equal(mockedDeleteRecord.mock.calls.length, 0);
  assert.equal(mockedRevokeShare.mock.calls.length, 0);
});

test("a workspace admin may delete another member's artifact", async () => {
  resolveAccess.mockResolvedValue(memberAccess());
  canAdministerContainer.mockReturnValue(true);
  mockedFindArtifact.mockResolvedValue(artifactRow());

  const result = await contentArtifactsService.deleteArtifact({
    workspaceId: WORKSPACE_ID,
    artifactId: ARTIFACT_ID,
    userId: "user-admin",
  });

  assert.equal(result.deleted, true);
});

test("another member's private artifact reads as not found, not forbidden", async () => {
  resolveAccess.mockResolvedValue(memberAccess());
  mockedFindArtifact.mockResolvedValue(
    artifactRow({ visibility: "private", createdBy: "someone-else" }),
  );

  await assert.rejects(
    contentArtifactsService.deleteArtifact({
      workspaceId: WORKSPACE_ID,
      artifactId: ARTIFACT_ID,
      userId: "user-other",
    }),
    (error: unknown) =>
      error instanceof ContentError && error.code === "ARTIFACT_NOT_FOUND",
  );
});

test("a failed byte delete does not fail the request", async () => {
  resolveAccess.mockResolvedValue(memberAccess());
  mockedFindArtifact.mockResolvedValue(artifactRow());
  mockedDeleteObject.mockRejectedValue(new Error("storage down"));

  const result = await contentArtifactsService.deleteArtifact({
    workspaceId: WORKSPACE_ID,
    artifactId: ARTIFACT_ID,
    userId: CREATOR_ID,
  });

  assert.equal(result.deleted, true);
});
