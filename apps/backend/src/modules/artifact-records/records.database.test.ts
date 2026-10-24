import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import {
  artifactRecordOperationSchema,
  type ArtifactRecordOperationInput,
  type ArtifactRecordResult,
} from "@sourceweft/contracts/artifact-records";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let db: typeof import("@sourceweft/db");
let repository: typeof import("./repository");
let service: import("./service").ArtifactRecordsService;
const originalDatabaseUrl = process.env.DATABASE_URL;

const teamId = randomUUID();
const workspaceId = randomUUID();
const editor = randomUUID();
const viewer = randomUUID();
const artifactId = randomUUID();
const sharedArtifactId = randomUUID();
const v1 = randomUUID();
const v2 = randomUUID();
const sharedVersion = randomUUID();

async function insertArtifact(
  id: string,
  versions: { id: string; no: number; capabilities: string[] }[],
) {
  await db.db.insert(db.artifacts).values({
    id,
    teamId,
    workspaceId,
    artifactType: "html",
    status: "ready",
    currentVersionNo: versions.at(-1)!.no,
    visibility: "workspace",
    createdBy: editor,
  });
  for (const version of versions)
    await db.db.insert(db.artifactVersions).values({
      id: version.id,
      teamId,
      workspaceId,
      artifactId: id,
      versionNo: version.no,
      createdBy: editor,
      contentJson: {
        schemaVersion: 1,
        metadata: { schemaVersion: 1, capabilities: version.capabilities },
      },
    });
}

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("artifact_records");
  process.env.DATABASE_URL = isolated.url;
  db = await import("@sourceweft/db");
  repository = await import("./repository");
  const { ArtifactRecordsService } = await import("./service");
  service = new ArtifactRecordsService({ allow: async () => true });

  await db.database.query(
    'insert into organization (id,name,slug,"createdAt") values ($1,$1,$1,now())',
    [teamId],
  );
  await db.db.insert(db.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Records",
    slug: workspaceId,
  });
  for (const [userId, role] of [
    [editor, "editor"],
    [viewer, "viewer"],
  ] as const) {
    await db.database.query(
      'insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())',
      [userId, `${userId}@example.test`],
    );
    await db.db.insert(db.workspaceMemberships).values({
      workspaceId,
      userId,
      role,
      source: "guest",
    });
  }
  await insertArtifact(artifactId, [
    { id: v1, no: 1, capabilities: ["storage"] },
    { id: v2, no: 2, capabilities: ["storage"] },
  ]);
  await insertArtifact(sharedArtifactId, [
    { id: sharedVersion, no: 1, capabilities: ["storage.shared"] },
  ]);
}, 120_000);

afterAll(async () => {
  if (db) await db.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function run(
  operation: ArtifactRecordOperationInput,
  options: { userId?: string; versionId?: string; artifact?: string } = {},
): Promise<ArtifactRecordResult> {
  return service.execute({
    workspaceId,
    artifactId: options.artifact ?? artifactId,
    userId: options.userId ?? editor,
    versionId: options.versionId ?? v1,
    operation: artifactRecordOperationSchema.parse(operation),
  });
}

test("records round-trip, belong to their viewer, and survive a new version", async () => {
  const written = await run({
    op: "set",
    collection: "kv",
    id: "draft",
    data: { b: 2, a: [1, "x", null] },
  });
  assert.equal(written.op, "set");
  const mine = await run(
    { op: "get", collection: "kv", id: "draft" },
    { versionId: v2 },
  );
  assert.ok(mine.op === "get" && mine.record);
  assert.deepEqual(mine.record.data, { a: [1, "x", null], b: 2 });
  assert.equal(written.op === "set" && written.etag, mine.record.etag);

  const theirs = await run(
    { op: "get", collection: "kv", id: "draft" },
    { userId: viewer },
  );
  assert.deepEqual(theirs, { op: "get", record: null });
  await run(
    { op: "set", collection: "kv", id: "draft", data: "viewer's" },
    { userId: viewer },
  );
  const again = await run({ op: "get", collection: "kv", id: "draft" });
  assert.ok(again.op === "get" && again.record);
  assert.deepEqual(again.record.data, { a: [1, "x", null], b: 2 });
});

test("ifMatch guards concurrent edits", async () => {
  const first = await run({ op: "set", collection: "notes", id: "n", data: 1 });
  assert.ok(first.op === "set");
  const second = await run({
    op: "set",
    collection: "notes",
    id: "n",
    data: 2,
    ifMatch: first.etag,
  });
  assert.ok(second.op === "set");
  assert.notEqual(second.etag, first.etag);
  await assert.rejects(
    run({
      op: "set",
      collection: "notes",
      id: "n",
      data: 3,
      ifMatch: first.etag,
    }),
    /record changed/u,
  );
  await assert.rejects(
    run({ op: "delete", collection: "notes", id: "n", ifMatch: first.etag }),
    /record changed/u,
  );
  assert.deepEqual(
    await run({
      op: "delete",
      collection: "notes",
      id: "n",
      ifMatch: second.etag,
    }),
    { op: "delete", deleted: true },
  );
  assert.deepEqual(await run({ op: "delete", collection: "notes", id: "n" }), {
    op: "delete",
    deleted: false,
  });
});

test("queries filter, sort and paginate without gaps or repeats", async () => {
  const tasks = [
    { id: "t1", data: { title: "a", priority: 3, tags: ["x"], done: false } },
    { id: "t2", data: { title: "b", priority: 1, tags: ["y"], done: true } },
    {
      id: "t3",
      data: { title: "c", priority: 3, tags: ["x", "y"], done: false },
    },
    {
      id: "t4",
      data: { title: "d", priority: 2, done: false, meta: { owner: "ada" } },
    },
    { id: "t5", data: { title: "e", priority: "high", done: false } },
    { id: "other/1", data: { title: "f" } },
  ];
  for (const task of tasks)
    await run({ op: "set", collection: "tasks", id: task.id, data: task.data });
  const ids = async (
    query: Omit<
      Extract<ArtifactRecordOperationInput, { op: "query" }>,
      "op" | "collection"
    >,
  ) => {
    const result = await run({ op: "query", collection: "tasks", ...query });
    assert.ok(result.op === "query");
    return result.records.map((record) => record.id);
  };

  assert.deepEqual(
    await ids({ where: [{ path: "done", op: "eq", value: false }] }),
    ["t1", "t3", "t4", "t5"],
  );
  assert.deepEqual(
    await ids({ where: [{ path: "tags", op: "eq", value: ["x"] }] }),
    ["t1"],
  );
  assert.deepEqual(
    await ids({ where: [{ path: "tags", op: "contains", value: ["y"] }] }),
    ["t2", "t3"],
  );
  assert.deepEqual(
    await ids({ where: [{ path: "meta.owner", op: "exists" }] }),
    ["t4"],
  );
  assert.deepEqual(
    await ids({ where: [{ path: "priority", op: "gte", value: 2 }] }),
    ["t1", "t3", "t4"],
  );
  assert.deepEqual(
    await ids({ where: [{ path: "priority", op: "in", value: [1, "high"] }] }),
    ["t2", "t5"],
  );
  assert.deepEqual(
    await ids({ where: [{ path: "done", op: "ne", value: false }] }),
    ["other/1", "t2"],
  );
  assert.deepEqual(await ids({ idPrefix: "other/" }), ["other/1"]);

  const orderBy = [
    { path: "priority", dir: "desc" as const },
    { path: "title", dir: "asc" as const },
  ];
  const all = await ids({ orderBy, limit: 100 });
  const paged: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await run({
      op: "query",
      collection: "tasks",
      orderBy,
      limit: 2,
      cursor,
    });
    assert.ok(page.op === "query");
    paged.push(...page.records.map((record) => record.id));
    cursor = page.cursor ?? undefined;
  } while (cursor);
  assert.equal(all.length, tasks.length);
  assert.deepEqual(paged, all);
  // jsonb orders numbers above strings and missing fields (as null) last.
  assert.deepEqual(all, ["t1", "t3", "t4", "t2", "t5", "other/1"]);
});

test("shared records need approval and consent, and are one row per key", async () => {
  const shared = { scope: "shared" as const, collection: "board", id: "row-1" };
  const sharedRun = (
    operation: ArtifactRecordOperationInput,
    userId = editor,
  ) =>
    run(operation, {
      userId,
      artifact: sharedArtifactId,
      versionId: sharedVersion,
    });
  const versionInput = {
    workspaceId,
    artifactId: sharedArtifactId,
    versionId: sharedVersion,
  };

  await assert.rejects(
    sharedRun({ op: "get", ...shared }),
    /not been approved/u,
  );
  await assert.rejects(
    service.approveShared({ ...versionInput, userId: viewer }),
    /Only workspace editors/u,
  );
  await service.approveShared({ ...versionInput, userId: editor });
  await assert.rejects(sharedRun({ op: "get", ...shared }), /Allow this page/u);
  await service.grantConsent({ ...versionInput, userId: editor });
  await service.grantConsent({ ...versionInput, userId: viewer });

  await sharedRun({ op: "set", ...shared, data: { votes: 1 } });
  await sharedRun({ op: "set", ...shared, data: { votes: 2 } });
  await assert.rejects(
    sharedRun({ op: "set", ...shared, data: { votes: 9 } }, viewer),
    /read-only/u,
  );
  const read = await sharedRun({ op: "get", ...shared }, viewer);
  assert.ok(read.op === "get" && read.record);
  assert.deepEqual(read.record.data, { votes: 2 });
  const rows = await db.database.query(
    "select count(*)::int as n from artifact_records where artifact_id = $1 and scope = 'shared'",
    [sharedArtifactId],
  );
  assert.equal(rows.rows[0].n, 1);

  const status = await service.status({ ...versionInput, userId: viewer });
  assert.equal(status.consented, true);
  assert.equal(status.canApprove, false);
  assert.equal(status.approval?.approvedBy?.id, editor);

  await service.revokeShared({ ...versionInput, userId: editor });
  await assert.rejects(
    sharedRun({ op: "get", ...shared }, viewer),
    /not been approved/u,
  );
  await service.approveShared({ ...versionInput, userId: editor });

  const share = randomUUID();
  await db.db.insert(db.shareLinks).values({
    id: share,
    teamId,
    workspaceId,
    targetType: "artifact",
    targetId: sharedArtifactId,
    token: `token-${share}`,
    isPublic: true,
    publicRecordCollections: ["board"],
  });
  const publicRead = await service.executePublic({
    token: `token-${share}`,
    clientKey: "test",
    operation: artifactRecordOperationSchema.parse({ op: "get", ...shared }),
  });
  assert.ok(publicRead.op === "get" && publicRead.record);
  assert.deepEqual(publicRead.record.data, { votes: 2 });
  await db.database.query(
    "update share_links set revoked_at = now() where id = $1",
    [share],
  );
  await assert.rejects(
    service.executePublic({
      token: `token-${share}`,
      clientKey: "test",
      operation: artifactRecordOperationSchema.parse({ op: "get", ...shared }),
    }),
    /not available/u,
  );
});

test("quotas are enforced inside the write transaction", async () => {
  const limits = {
    recordsPerCollection: 2,
    collectionsPerPartition: 2,
    partitionBytes: 40,
  };
  const write = (collection: string, recordId: string, sizeBytes = 5) =>
    repository.writeRecord({
      key: {
        artifactId,
        scope: "user",
        ownerUserId: viewer,
        collection,
        recordId,
      },
      teamId,
      workspaceId,
      actorUserId: viewer,
      data: { n: 1 },
      sizeBytes,
      limits,
    });
  await db.database.query(
    "delete from artifact_records where owner_user_id = $1",
    [viewer],
  );
  assert.equal((await write("q1", "a")).kind, "written");
  assert.equal((await write("q1", "b")).kind, "written");
  assert.equal((await write("q1", "c")).kind, "quota_exceeded");
  assert.equal((await write("q1", "a")).kind, "written");
  assert.equal((await write("q2", "a")).kind, "written");
  assert.equal((await write("q3", "a")).kind, "quota_exceeded");
  assert.equal((await write("q2", "b", 30)).kind, "quota_exceeded");
});

test("account and artifact deletion remove their records", async () => {
  await run(
    { op: "set", collection: "kv", id: "mine", data: 1 },
    { userId: viewer },
  );
  await repository.deleteUserRecordData(viewer);
  const left = await db.database.query(
    "select scope, owner_user_id from artifact_records where owner_user_id = $1 or (scope = 'shared' and artifact_id = $2)",
    [viewer, sharedArtifactId],
  );
  assert.deepEqual(left.rows, [{ scope: "shared", owner_user_id: null }]);
  const consents = await db.database.query(
    "select count(*)::int as n from artifact_record_consents where user_id = $1",
    [viewer],
  );
  assert.equal(consents.rows[0].n, 0);

  await db.database.query("delete from artifacts where id = $1", [
    sharedArtifactId,
  ]);
  for (const table of [
    "artifact_records",
    "artifact_capability_approvals",
    "artifact_record_consents",
  ]) {
    const rows = await db.database.query(
      `select count(*)::int as n from ${table} where artifact_id = $1`,
      [sharedArtifactId],
    );
    assert.equal(rows.rows[0].n, 0, table);
  }
});
