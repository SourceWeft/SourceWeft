import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import {
  ARTIFACT_RECORD_LIMITS,
  artifactRecordOperationSchema,
  type ArtifactRecordOperationInput,
} from "@sourceweft/contracts/artifact-records";

const mocks = vi.hoisted(() => ({
  resolveAccess: vi.fn(),
  findReadyVersion: vi.fn(),
  findArtifact: vi.fn(),
  findCurrentVersion: vi.fn(),
  findLiveShare: vi.fn(),
  audit: vi.fn(),
  readRecord: vi.fn(),
  writeRecord: vi.fn(),
  deleteRecord: vi.fn(),
  queryRecords: vi.fn(),
  findApproval: vi.fn(),
  hasConsent: vi.fn(),
  grantConsent: vi.fn(),
  approve: vi.fn(),
  revoke: vi.fn(),
  author: vi.fn(),
  names: vi.fn(),
  deleteUserData: vi.fn(),
  allow: vi.fn(),
}));

vi.mock("../workspace", () => ({
  workspaceService: { resolveAccess: mocks.resolveAccess },
}));
vi.mock("../artifacts/repository", () => ({
  findReadyArtifactVersionRecord: mocks.findReadyVersion,
  findArtifactRecord: mocks.findArtifact,
  findCurrentReadyArtifactVersionRecord: mocks.findCurrentVersion,
}));
vi.mock("../sharing/store", () => ({
  findLiveShareByToken: mocks.findLiveShare,
}));
vi.mock("../team-audit", () => ({ teamAuditService: { record: mocks.audit } }));
vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./rate-limit", () => ({ redisRecordRateLimiter: { allow: vi.fn() } }));
vi.mock("./repository", async () => {
  class RecordQueryTimeoutError extends Error {}
  return {
    RecordQueryTimeoutError,
    readRecord: mocks.readRecord,
    writeRecord: mocks.writeRecord,
    deleteRecord: mocks.deleteRecord,
    queryRecords: mocks.queryRecords,
    findActiveSharedApproval: mocks.findApproval,
    hasSharedConsent: mocks.hasConsent,
    grantSharedConsent: mocks.grantConsent,
    approveShared: mocks.approve,
    revokeShared: mocks.revoke,
    findVersionAuthor: mocks.author,
    findUserNames: mocks.names,
    deleteUserRecordData: mocks.deleteUserData,
  };
});

import { ContentError } from "../content/errors";
import { RecordQueryTimeoutError } from "./repository";
import { ArtifactRecordsService } from "./service";

const service = new ArtifactRecordsService({ allow: mocks.allow });

function version(
  capabilities: string[] | undefined,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "artifact-1",
    artifactType: "html",
    visibility: "workspace",
    createdBy: "author-1",
    versionId: "version-1",
    versionNo: 1,
    contentJson: {
      metadata: capabilities
        ? { schemaVersion: 1, capabilities }
        : { schemaVersion: 1 },
    },
    ...overrides,
  };
}

function access(role: "viewer" | "editor" | "workspace_admin" | null) {
  return {
    workspaceId: "ws-1",
    organizationId: "team-1",
    userId: "user-1",
    role,
  };
}

const op = (input: ArtifactRecordOperationInput) =>
  artifactRecordOperationSchema.parse(input);

const call = (operation: ArtifactRecordOperationInput, userId = "user-1") =>
  service.execute({
    workspaceId: "ws-1",
    artifactId: "artifact-1",
    userId,
    versionId: "version-1",
    operation: op(operation),
  });

async function rejectsWith(
  promise: Promise<unknown>,
  code: string,
  status?: number,
) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ContentError, String(error));
    assert.equal(error.code, code);
    if (status) assert.equal(error.statusCode, status);
    return true;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAccess.mockResolvedValue(access("editor"));
  mocks.findReadyVersion.mockResolvedValue(version(["storage"]));
  mocks.allow.mockResolvedValue(true);
  mocks.findApproval.mockResolvedValue({
    approvedBy: "editor-1",
    approvedAt: new Date(0),
  });
  mocks.hasConsent.mockResolvedValue(true);
  mocks.writeRecord.mockResolvedValue({
    kind: "written",
    etag: "etag-12345",
    updatedAt: "2026-01-01T00:00:00.000Z",
    created: true,
  });
  mocks.readRecord.mockResolvedValue(null);
  mocks.names.mockResolvedValue(new Map());
});

test("unreachable artifacts all look unavailable", async () => {
  mocks.resolveAccess.mockResolvedValueOnce(null);
  await rejectsWith(
    call({ op: "get", collection: "kv", id: "a" }),
    "ARTIFACT_RECORD_UNAVAILABLE",
    404,
  );
  mocks.resolveAccess.mockResolvedValueOnce(access(null));
  await rejectsWith(
    call({ op: "get", collection: "kv", id: "a" }),
    "ARTIFACT_RECORD_UNAVAILABLE",
  );
  mocks.findReadyVersion.mockResolvedValueOnce(null);
  await rejectsWith(
    call({ op: "get", collection: "kv", id: "a" }),
    "ARTIFACT_RECORD_UNAVAILABLE",
  );
  mocks.findReadyVersion.mockResolvedValueOnce(
    version(["storage"], { artifactType: "report" }),
  );
  await rejectsWith(
    call({ op: "get", collection: "kv", id: "a" }),
    "ARTIFACT_RECORD_UNAVAILABLE",
  );
  mocks.findReadyVersion.mockResolvedValueOnce(
    version(["storage"], { visibility: "private", createdBy: "someone-else" }),
  );
  await rejectsWith(
    call({ op: "get", collection: "kv", id: "a" }),
    "ARTIFACT_RECORD_UNAVAILABLE",
  );
  assert.equal(mocks.readRecord.mock.calls.length, 0);
});

test("the version's own declaration gates storage, whatever the host sends", async () => {
  mocks.findReadyVersion.mockResolvedValue(version(undefined));
  await rejectsWith(
    call({ op: "get", collection: "kv", id: "a" }),
    "ARTIFACT_RECORD_FORBIDDEN",
    403,
  );
  assert.deepEqual(mocks.findReadyVersion.mock.calls[0]![0], {
    teamId: "team-1",
    workspaceId: "ws-1",
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
  });
});

test("user scope is owned by the session, for every role including viewers", async () => {
  for (const role of ["viewer", "editor", "workspace_admin"] as const) {
    mocks.resolveAccess.mockResolvedValueOnce(access(role));
    const result = await call(
      { op: "set", collection: "notes", id: "n1", data: { text: "hi" } },
      "user-7",
    );
    assert.deepEqual(result, {
      op: "set",
      etag: "etag-12345",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  }
  for (const [input] of mocks.writeRecord.mock.calls) {
    assert.deepEqual(input.key, {
      artifactId: "artifact-1",
      scope: "user",
      ownerUserId: "user-7",
      collection: "notes",
      recordId: "n1",
    });
    assert.equal(
      input.limits.partitionBytes,
      ARTIFACT_RECORD_LIMITS.userBytesPerArtifact,
    );
    assert.equal(
      input.sizeBytes,
      Buffer.byteLength(JSON.stringify({ text: "hi" })),
    );
  }
});

test("shared scope needs the declaration, a person's approval and the viewer's consent", async () => {
  await rejectsWith(
    call({ op: "get", scope: "shared", collection: "kv", id: "a" }),
    "ARTIFACT_RECORD_FORBIDDEN",
  );
  mocks.findReadyVersion.mockResolvedValue(version(["storage.shared"]));
  mocks.findApproval.mockResolvedValueOnce(null);
  await assert.rejects(
    call({ op: "get", scope: "shared", collection: "kv", id: "a" }),
    (error: unknown) => {
      assert.ok(error instanceof ContentError);
      assert.equal(error.code, "ARTIFACT_RECORD_FORBIDDEN");
      assert.deepEqual(error.details, { reason: "capability_not_approved" });
      return true;
    },
  );
  mocks.hasConsent.mockResolvedValueOnce(false);
  await rejectsWith(
    call({ op: "get", scope: "shared", collection: "kv", id: "a" }),
    "ARTIFACT_RECORD_CONSENT_REQUIRED",
    403,
  );
  assert.deepEqual(mocks.hasConsent.mock.calls.at(-1)![0], {
    userId: "user-1",
    versionId: "version-1",
  });
  const result = await call({
    op: "get",
    scope: "shared",
    collection: "kv",
    id: "a",
  });
  assert.deepEqual(result, { op: "get", record: null });
  assert.equal(mocks.readRecord.mock.calls.at(-1)![0].ownerUserId, null);
});

test("viewers read shared records but only editors and admins write them", async () => {
  mocks.findReadyVersion.mockResolvedValue(version(["storage.shared"]));
  mocks.resolveAccess.mockResolvedValue(access("viewer"));
  await call({ op: "query", scope: "shared", collection: "c" }).catch(
    () => undefined,
  );
  await rejectsWith(
    call({ op: "set", scope: "shared", collection: "c", id: "x", data: 1 }),
    "ARTIFACT_RECORD_FORBIDDEN",
  );
  await rejectsWith(
    call({ op: "delete", scope: "shared", collection: "c", id: "x" }),
    "ARTIFACT_RECORD_FORBIDDEN",
  );
  assert.equal(mocks.writeRecord.mock.calls.length, 0);
  mocks.resolveAccess.mockResolvedValue(access("editor"));
  await call({ op: "set", scope: "shared", collection: "c", id: "x", data: 1 });
  const [input] = mocks.writeRecord.mock.calls[0]!;
  assert.equal(input.key.ownerUserId, null);
  assert.equal(
    input.limits.partitionBytes,
    ARTIFACT_RECORD_LIMITS.sharedBytesPerArtifact,
  );
});

test("invalid data, conflicts and quotas map to the page's error codes", async () => {
  await rejectsWith(
    call({ op: "set", collection: "c", id: "x", data: { bad: "\u0000" } }),
    "ARTIFACT_RECORD_INVALID_REQUEST",
    400,
  );
  mocks.writeRecord.mockResolvedValueOnce({ kind: "conflict" });
  await rejectsWith(
    call({
      op: "set",
      collection: "c",
      id: "x",
      data: 1,
      ifMatch: "etag-00000",
    }),
    "ARTIFACT_RECORD_CONFLICT",
    409,
  );
  mocks.writeRecord.mockResolvedValueOnce({
    kind: "quota_exceeded",
    reason: "full",
  });
  await rejectsWith(
    call({ op: "set", collection: "c", id: "x", data: 1 }),
    "ARTIFACT_RECORD_QUOTA_EXCEEDED",
    413,
  );
  mocks.deleteRecord.mockResolvedValueOnce({ kind: "conflict" });
  await rejectsWith(
    call({ op: "delete", collection: "c", id: "x", ifMatch: "etag-00000" }),
    "ARTIFACT_RECORD_CONFLICT",
  );
  mocks.deleteRecord.mockResolvedValueOnce({ kind: "missing" });
  assert.deepEqual(await call({ op: "delete", collection: "c", id: "x" }), {
    op: "delete",
    deleted: false,
  });
});

test("rate limits are per viewer and artifact, and fail closed", async () => {
  mocks.allow.mockResolvedValueOnce(false);
  await rejectsWith(
    call({ op: "get", collection: "c", id: "x" }),
    "ARTIFACT_RECORD_RATE_LIMITED",
    429,
  );
  assert.deepEqual(mocks.allow.mock.calls[0], [
    "user-1:artifact-1:r",
    ARTIFACT_RECORD_LIMITS.readsPerSecond,
  ]);
  await call({ op: "set", collection: "c", id: "x", data: 1 });
  assert.deepEqual(mocks.allow.mock.calls[1], [
    "user-1:artifact-1:w",
    ARTIFACT_RECORD_LIMITS.writesPerSecond,
  ]);
  mocks.allow.mockRejectedValueOnce(new Error("redis down"));
  await rejectsWith(
    call({ op: "get", collection: "c", id: "x" }),
    "ARTIFACT_RECORD_UNAVAILABLE",
  );
});

function row(id: string, sizeBytes = 10) {
  return {
    id,
    data: { id },
    etag: "etag-12345",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sizeBytes,
    sortValues: [1],
  };
}

test("queries page with a cursor bound to the query", async () => {
  mocks.queryRecords.mockResolvedValueOnce([row("a"), row("b"), row("c")]);
  const first = await call({
    op: "query",
    collection: "tasks",
    orderBy: [{ path: "priority" }],
    limit: 2,
  });
  assert.equal(first.op, "query");
  if (first.op !== "query") return;
  assert.deepEqual(
    first.records.map((record) => record.id),
    ["a", "b"],
  );
  assert.equal("sizeBytes" in first.records[0]!, false);
  assert.ok(first.cursor);
  assert.equal(mocks.queryRecords.mock.calls[0]![0].fetch, 3);
  assert.equal(
    mocks.queryRecords.mock.calls[0]![0].partition.ownerUserId,
    "user-1",
  );

  mocks.queryRecords.mockResolvedValueOnce([row("c")]);
  const second = await call({
    op: "query",
    collection: "tasks",
    orderBy: [{ path: "priority" }],
    limit: 2,
    cursor: first.cursor,
  });
  assert.deepEqual(mocks.queryRecords.mock.calls[1]![0].cursor, {
    fingerprint: mocks.queryRecords.mock.calls[1]![0].cursor.fingerprint,
    values: [1],
    id: "b",
  });
  assert.equal(second.op === "query" && second.cursor, null);

  await rejectsWith(
    call({
      op: "query",
      collection: "other",
      orderBy: [{ path: "priority" }],
      cursor: first.cursor,
    }),
    "ARTIFACT_RECORD_INVALID_REQUEST",
  );
});

test("query responses stop at the byte budget but always return a row", async () => {
  const big = ARTIFACT_RECORD_LIMITS.queryResponseBytes;
  mocks.queryRecords.mockResolvedValueOnce([row("a", big), row("b", 1)]);
  const result = await call({ op: "query", collection: "c" });
  assert.ok(result.op === "query");
  if (result.op !== "query") return;
  assert.deepEqual(
    result.records.map((record) => record.id),
    ["a"],
  );
  assert.ok(result.cursor);
});

test("query filters are validated and slow queries are reported", async () => {
  await rejectsWith(
    call({
      op: "query",
      collection: "c",
      where: [{ path: "a", op: "eq", value: "\ud800" }],
    }),
    "ARTIFACT_RECORD_INVALID_REQUEST",
  );
  assert.equal(
    artifactRecordOperationSchema.safeParse({
      op: "query",
      collection: "c",
      where: [{ path: "a", op: "ne" }],
    }).success,
    false,
  );
  await rejectsWith(
    call({
      op: "query",
      collection: "c",
      where: [{ path: "a", op: "in", value: ["x\u0000"] }],
    }),
    "ARTIFACT_RECORD_INVALID_REQUEST",
  );
  await rejectsWith(
    call({
      op: "query",
      collection: "c",
      where: [{ path: "a", op: "gt", value: "\udc00" }],
    }),
    "ARTIFACT_RECORD_INVALID_REQUEST",
  );
  const { encodeQueryCursor, queryFingerprint } = await import("./query");
  const fingerprint = queryFingerprint({
    scope: "user",
    collection: "c",
    where: [],
    orderBy: [],
  });
  for (const forged of [
    encodeQueryCursor({ fingerprint, values: [], id: "x'--" }),
    encodeQueryCursor({ fingerprint, values: [], id: "\u0000" }),
  ])
    await rejectsWith(
      call({ op: "query", collection: "c", cursor: forged }),
      "ARTIFACT_RECORD_INVALID_REQUEST",
    );
  const sortedFingerprint = queryFingerprint({
    scope: "user",
    collection: "c",
    where: [],
    orderBy: [{ path: "a", dir: "asc" }],
  });
  await rejectsWith(
    call({
      op: "query",
      collection: "c",
      orderBy: [{ path: "a" }],
      cursor: encodeQueryCursor({
        fingerprint: sortedFingerprint,
        values: ["\u0000"],
        id: "ok",
      }),
    }),
    "ARTIFACT_RECORD_INVALID_REQUEST",
  );
  assert.equal(mocks.queryRecords.mock.calls.length, 0);
  mocks.queryRecords.mockRejectedValueOnce(new RecordQueryTimeoutError());
  await rejectsWith(
    call({ op: "query", collection: "c" }),
    "ARTIFACT_RECORD_QUERY_TOO_EXPENSIVE",
    422,
  );
});

function publicCall(operation: ArtifactRecordOperationInput) {
  return service.executePublic({
    token: "tok",
    clientKey: "1.2.3.4",
    operation: op(operation),
  });
}

test("public pages read only owner-chosen shared collections of an approved version", async () => {
  mocks.findLiveShare.mockResolvedValue({
    id: "share-1",
    targetType: "artifact",
    targetId: "artifact-1",
    isPublic: true,
    teamId: "team-1",
    workspaceId: "ws-1",
    publicRecordCollections: ["scores"],
  });
  mocks.findArtifact.mockResolvedValue({
    id: "artifact-1",
    teamId: "team-1",
    workspaceId: "ws-1",
    status: "ready",
    artifactType: "html",
  });
  mocks.findCurrentVersion.mockResolvedValue(version(["storage.shared"]));

  await rejectsWith(
    publicCall({ op: "get", collection: "scores", id: "a" }),
    "ARTIFACT_RECORD_UNAVAILABLE",
  );
  await rejectsWith(
    publicCall({
      op: "set",
      scope: "shared",
      collection: "scores",
      id: "a",
      data: 1,
    }),
    "ARTIFACT_RECORD_FORBIDDEN",
  );
  await rejectsWith(
    publicCall({ op: "get", scope: "shared", collection: "secrets", id: "a" }),
    "ARTIFACT_RECORD_FORBIDDEN",
  );
  mocks.findApproval.mockResolvedValueOnce(null);
  await rejectsWith(
    publicCall({ op: "get", scope: "shared", collection: "scores", id: "a" }),
    "ARTIFACT_RECORD_FORBIDDEN",
  );
  const result = await publicCall({
    op: "get",
    scope: "shared",
    collection: "scores",
    id: "a",
  });
  assert.deepEqual(result, { op: "get", record: null });
  assert.deepEqual(mocks.readRecord.mock.calls.at(-1)![0], {
    artifactId: "artifact-1",
    scope: "shared",
    ownerUserId: null,
    collection: "scores",
    recordId: "a",
  });
  assert.equal(mocks.allow.mock.calls.at(-1)![0], "share:share-1:1.2.3.4:r");

  mocks.findLiveShare.mockResolvedValueOnce(null);
  await rejectsWith(
    publicCall({ op: "get", scope: "shared", collection: "scores", id: "a" }),
    "ARTIFACT_RECORD_UNAVAILABLE",
  );
});

const versionInput = {
  workspaceId: "ws-1",
  artifactId: "artifact-1",
  versionId: "version-1",
  userId: "user-1",
};

test("only editors and admins approve, only for versions that ask, and it is audited", async () => {
  mocks.findReadyVersion.mockResolvedValue(version(["storage"]));
  await rejectsWith(
    service.approveShared(versionInput),
    "ARTIFACT_RECORD_INVALID_REQUEST",
  );
  mocks.findReadyVersion.mockResolvedValue(version(["storage.shared"]));
  mocks.resolveAccess.mockResolvedValueOnce(access("viewer"));
  await rejectsWith(
    service.approveShared(versionInput),
    "ARTIFACT_RECORD_FORBIDDEN",
  );
  assert.equal(mocks.approve.mock.calls.length, 0);

  mocks.approve.mockResolvedValueOnce({
    approvedBy: "user-1",
    approvedAt: new Date(0),
  });
  await service.approveShared(versionInput);
  assert.deepEqual(mocks.approve.mock.calls[0]![0], {
    versionId: "version-1",
    artifactId: "artifact-1",
    teamId: "team-1",
    userId: "user-1",
  });
  assert.equal(
    mocks.audit.mock.calls[0]![0].action,
    "artifact.storage_shared_approved",
  );

  mocks.revoke.mockResolvedValueOnce(true);
  assert.deepEqual(await service.revokeShared(versionInput), { revoked: true });
  assert.equal(
    mocks.audit.mock.calls[1]![0].action,
    "artifact.storage_shared_revoked",
  );
});

test("consent is per version and only for an approved request", async () => {
  mocks.findReadyVersion.mockResolvedValue(version(["storage.shared"]));
  mocks.findApproval.mockResolvedValueOnce(null);
  await rejectsWith(
    service.grantConsent(versionInput),
    "ARTIFACT_RECORD_FORBIDDEN",
  );
  await service.grantConsent({ ...versionInput, userId: "viewer-9" });
  assert.deepEqual(mocks.grantConsent.mock.calls[0]![0], {
    userId: "viewer-9",
    versionId: "version-1",
    artifactId: "artifact-1",
  });
});

test("status tells the host what to prompt for", async () => {
  mocks.findReadyVersion.mockResolvedValue(version(["storage.shared"]));
  mocks.author.mockResolvedValue("author-1");
  mocks.names.mockResolvedValue(
    new Map([
      ["author-1", "Ada"],
      ["editor-1", "Grace"],
    ]),
  );
  mocks.hasConsent.mockResolvedValue(false);
  mocks.resolveAccess.mockResolvedValue(access("viewer"));
  assert.deepEqual(await service.status(versionInput), {
    storage: true,
    shared: true,
    author: { id: "author-1", name: "Ada" },
    approval: {
      approvedBy: { id: "editor-1", name: "Grace" },
      approvedAt: new Date(0).toISOString(),
    },
    consented: false,
    canApprove: false,
  });
});
