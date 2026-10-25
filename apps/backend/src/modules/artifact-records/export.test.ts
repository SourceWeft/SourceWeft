import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAccess: vi.fn(),
  canAdministerContent: vi.fn(),
  findArtifact: vi.fn(),
  audit: vi.fn(),
  listPage: vi.fn(),
  clear: vi.fn(),
  allow: vi.fn(),
}));

vi.mock("../workspace", () => ({
  workspaceService: {
    resolveAccess: mocks.resolveAccess,
    canAdministerContent: mocks.canAdministerContent,
  },
}));
vi.mock("../artifacts/repository", () => ({
  findArtifactRecord: mocks.findArtifact,
}));
vi.mock("../team-audit", () => ({ teamAuditService: { record: mocks.audit } }));
vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./rate-limit", () => ({ redisRecordRateLimiter: { allow: vi.fn() } }));
vi.mock("./export-repository", () => ({
  listRecordPage: mocks.listPage,
  clearRecords: mocks.clear,
}));
vi.mock("./service", async () => {
  const { ContentError } = await import("../content/errors");
  return {
    artifactRecordError: (code: string, message: string) =>
      new ContentError(
        code === "forbidden" ? 403 : code === "unavailable" ? 404 : 400,
        `ARTIFACT_RECORD_${code.toUpperCase()}`,
        message,
      ),
  };
});

import { ContentError } from "../content/errors";
import { ArtifactRecordsExportService } from "./export";

const service = new ArtifactRecordsExportService({ allow: mocks.allow }, 2);

function access(role: "viewer" | "editor" | "workspace_admin" | null) {
  return {
    workspaceId: "ws-1",
    organizationId: "team-1",
    userId: "user-1",
    role,
  };
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    id: "artifact-1",
    teamId: "team-1",
    workspaceId: "ws-1",
    artifactType: "html",
    visibility: "workspace",
    createdBy: "author-1",
    ...overrides,
  };
}

const input = (
  scope: "user" | "shared",
  userId = "user-1",
  collection?: string,
) => ({
  workspaceId: "ws-1",
  artifactId: "artifact-1",
  userId,
  scope,
  collection,
});

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ContentError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

function row(collection: string, id: string) {
  return {
    collection,
    id,
    data: { n: id },
    etag: `etag-${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAccess.mockResolvedValue(access("editor"));
  mocks.canAdministerContent.mockImplementation(
    (value: { role: string | null }) => value.role === "workspace_admin",
  );
  mocks.findArtifact.mockResolvedValue(artifact());
  mocks.allow.mockResolvedValue(true);
  mocks.listPage.mockResolvedValue([]);
  mocks.clear.mockResolvedValue(0);
});

test("unreachable artifacts all look unavailable", async () => {
  mocks.resolveAccess.mockResolvedValueOnce(null);
  await rejectsWith(
    service.export(input("user")),
    "ARTIFACT_RECORD_UNAVAILABLE",
  );
  mocks.resolveAccess.mockResolvedValueOnce(access(null));
  await rejectsWith(
    service.clear(input("user")),
    "ARTIFACT_RECORD_UNAVAILABLE",
  );
  mocks.findArtifact.mockResolvedValueOnce(null);
  await rejectsWith(
    service.export(input("user")),
    "ARTIFACT_RECORD_UNAVAILABLE",
  );
  mocks.findArtifact.mockResolvedValueOnce(
    artifact({ artifactType: "report" }),
  );
  await rejectsWith(
    service.clear(input("user")),
    "ARTIFACT_RECORD_UNAVAILABLE",
  );
  // Someone else's private artifact stays hidden, even from an admin.
  mocks.resolveAccess.mockResolvedValueOnce(access("workspace_admin"));
  mocks.findArtifact.mockResolvedValueOnce(artifact({ visibility: "private" }));
  await rejectsWith(
    service.export(input("shared")),
    "ARTIFACT_RECORD_UNAVAILABLE",
  );
  assert.equal(mocks.listPage.mock.calls.length, 0);
  assert.equal(mocks.clear.mock.calls.length, 0);
  assert.equal(mocks.audit.mock.calls.length, 0);
});

test("every member, whatever the role, reaches only their own user records", async () => {
  for (const role of ["viewer", "editor", "workspace_admin"] as const) {
    mocks.resolveAccess.mockResolvedValue(access(role));
    mocks.clear.mockClear();
    mocks.listPage.mockClear();
    await service.clear(input("user", "user-1"));
    assert.deepEqual(mocks.clear.mock.calls[0]![0].partition, {
      artifactId: "artifact-1",
      scope: "user",
      ownerUserId: "user-1",
    });
    const { stream } = await service.export(input("user", "user-1"));
    await readAll(stream);
    assert.deepEqual(mocks.listPage.mock.calls[0]![0].partition, {
      artifactId: "artifact-1",
      scope: "user",
      ownerUserId: "user-1",
    });
  }
});

test("the partition owner is the caller, so a creator or admin never reaches another user's data", async () => {
  mocks.resolveAccess.mockResolvedValue(access("workspace_admin"));
  mocks.findArtifact.mockResolvedValue(artifact({ createdBy: "admin-1" }));
  await service.clear(input("user", "admin-1"));
  assert.equal(mocks.clear.mock.calls[0]![0].partition.ownerUserId, "admin-1");
  const { stream } = await service.export(input("user", "admin-1"));
  await readAll(stream);
  assert.equal(
    mocks.listPage.mock.calls[0]![0].partition.ownerUserId,
    "admin-1",
  );
});

test("shared data needs the creator or a content admin", async () => {
  // A plain editor or viewer who did not create the artifact.
  for (const role of ["viewer", "editor"] as const) {
    mocks.resolveAccess.mockResolvedValue(access(role));
    await rejectsWith(
      service.export(input("shared")),
      "ARTIFACT_RECORD_FORBIDDEN",
    );
    await rejectsWith(
      service.clear(input("shared")),
      "ARTIFACT_RECORD_FORBIDDEN",
    );
  }
  assert.equal(mocks.clear.mock.calls.length, 0);
  assert.equal(mocks.audit.mock.calls.length, 0);

  // The creator, even with a reduced role.
  mocks.resolveAccess.mockResolvedValue(access("viewer"));
  mocks.findArtifact.mockResolvedValue(artifact({ createdBy: "user-1" }));
  mocks.clear.mockResolvedValue(3);
  assert.deepEqual(await service.clear(input("shared")), { removed: 3 });
  assert.deepEqual(mocks.clear.mock.calls[0]![0].partition, {
    artifactId: "artifact-1",
    scope: "shared",
    ownerUserId: null,
  });

  // A content admin who did not create it.
  mocks.resolveAccess.mockResolvedValue(access("workspace_admin"));
  mocks.findArtifact.mockResolvedValue(artifact());
  const { stream } = await service.export(input("shared"));
  await readAll(stream);
  assert.equal(mocks.listPage.mock.calls[0]![0].partition.scope, "shared");
});

test("clearing audits the scope, collection and count, never data", async () => {
  mocks.clear.mockResolvedValue(7);
  assert.deepEqual(await service.clear(input("user", "user-1", "scores")), {
    removed: 7,
  });
  assert.equal(mocks.clear.mock.calls[0]![0].collection, "scores");
  assert.deepEqual(mocks.audit.mock.calls[0]![0], {
    teamId: "team-1",
    actorUserId: "user-1",
    action: "artifact.records_cleared",
    targetType: "artifact",
    targetId: "artifact-1",
    metadata: { scope: "user", collection: "scores", removed: 7 },
  });
});

test("an export is one valid JSON document, paged by keyset, and audited with counts", async () => {
  mocks.listPage
    .mockResolvedValueOnce([row("a", "1"), row("a", "2")])
    .mockResolvedValueOnce([row("b", "1"), row("b", "2")])
    .mockResolvedValueOnce([]);
  const { filename, stream } = await service.export(input("user"));
  assert.equal(filename, "artifact-1-user-records.json");
  const document = JSON.parse(await readAll(stream));
  assert.equal(document.format, "sourceweft.artifact-records");
  assert.equal(document.scope, "user");
  assert.equal(document.records.length, 4);
  assert.deepEqual(document.records[3], {
    scope: "user",
    collection: "b",
    id: "2",
    data: { n: "2" },
    etag: "etag-2",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  });
  // Each page resumes after the previous page's last row.
  assert.equal(mocks.listPage.mock.calls[0]![0].after, null);
  assert.deepEqual(mocks.listPage.mock.calls[1]![0].after, {
    collection: "a",
    id: "2",
  });
  assert.deepEqual(mocks.listPage.mock.calls[2]![0].after, {
    collection: "b",
    id: "2",
  });
  assert.equal(mocks.listPage.mock.calls[0]![0].limit, 2);
  assert.deepEqual(mocks.audit.mock.calls[0]![0].metadata, {
    scope: "user",
    records: 4,
    complete: true,
  });
  assert.equal(
    mocks.audit.mock.calls[0]![0].action,
    "artifact.records_exported",
  );
});

test("an empty export is still valid JSON", async () => {
  const { stream } = await service.export(input("user", "user-1", "scores"));
  const document = JSON.parse(await readAll(stream));
  assert.deepEqual(document.records, []);
  assert.equal(document.collection, "scores");
  assert.equal(mocks.listPage.mock.calls[0]![0].collection, "scores");
});

test("a failure part way errors the stream instead of closing a partial document", async () => {
  mocks.listPage
    .mockResolvedValueOnce([row("a", "1"), row("a", "2")])
    .mockRejectedValueOnce(new Error("db down"));
  const { stream } = await service.export(input("user"));
  await assert.rejects(readAll(stream), /db down/u);
  assert.deepEqual(mocks.audit.mock.calls[0]![0].metadata, {
    scope: "user",
    records: 2,
    complete: false,
  });
});

test("requests over the rate limit are refused before any lookup", async () => {
  mocks.allow.mockResolvedValueOnce(false);
  await rejectsWith(
    service.export(input("user")),
    "ARTIFACT_RECORD_RATE_LIMITED",
  );
  assert.equal(mocks.resolveAccess.mock.calls.length, 0);
  mocks.allow.mockRejectedValueOnce(new Error("redis down"));
  await rejectsWith(
    service.clear(input("user")),
    "ARTIFACT_RECORD_UNAVAILABLE",
  );
});
