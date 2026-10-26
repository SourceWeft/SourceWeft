import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { ContentError } from "../content/errors";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let db: typeof import("@sourceweft/db");
let service: import("./export").ArtifactRecordsExportService;
const originalDatabaseUrl = process.env.DATABASE_URL;

const teamId = randomUUID();
const workspaceId = randomUUID();
const creator = randomUUID();
const admin = randomUUID();
const editor = randomUUID();
const viewer = randomUUID();
const outsider = randomUUID();
const artifactId = randomUUID();
const otherArtifactId = randomUUID();
const privateArtifactId = randomUUID();
const pptxArtifactId = randomUUID();

async function insertArtifact(
  id: string,
  overrides: {
    artifactType?: "html" | "report";
    visibility?: "workspace" | "private";
  } = {},
) {
  await db.db.insert(db.artifacts).values({
    id,
    teamId,
    workspaceId,
    artifactType: overrides.artifactType ?? "html",
    status: "ready",
    currentVersionNo: 1,
    visibility: overrides.visibility ?? "workspace",
    createdBy: creator,
  });
}

async function seed(
  artifact: string,
  scope: "user" | "shared",
  owner: string | null,
  collection: string,
  count: number,
  prefix = "r",
) {
  const now = new Date("2026-02-03T04:05:06.000Z");
  const values = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    teamId,
    workspaceId,
    artifactId: artifact,
    scope,
    ownerUserId: owner,
    collection,
    // Zero-padded so the expected order is the lexicographic one.
    recordId: `${prefix}${String(index).padStart(5, "0")}`,
    data: { index, text: `value ${index}` },
    sizeBytes: 10,
    etag: `etag-${index}`,
    createdBy: owner ?? creator,
    updatedBy: owner ?? creator,
    createdAt: now,
    updatedAt: now,
  }));
  for (let start = 0; start < values.length; start += 500)
    await db.db
      .insert(db.artifactRecords)
      .values(values.slice(start, start + 500));
}

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("records_export");
  process.env.DATABASE_URL = isolated.url;
  db = await import("@sourceweft/db");
  const { ArtifactRecordsExportService } = await import("./export");
  service = new ArtifactRecordsExportService({ allow: async () => true });

  await db.database.query(
    'insert into organization (id,name,slug,"createdAt") values ($1,$1,$1,now())',
    [teamId],
  );
  await db.db.insert(db.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Export",
    slug: workspaceId,
  });
  for (const [userId, role] of [
    [creator, "editor"],
    [admin, "workspace_admin"],
    [editor, "editor"],
    [viewer, "viewer"],
  ] as const) {
    await db.database.query(
      'insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())',
      [userId, `${userId}@example.test`],
    );
    // Organization members: a guest's role is capped below workspace_admin.
    await db.database.query(
      `insert into member (id, "organizationId", "userId", role, "createdAt") values ($1, $2, $1, 'member', now())`,
      [userId, teamId],
    );
    await db.db.insert(db.workspaceMemberships).values({
      workspaceId,
      userId,
      role,
      source: "direct",
    });
  }
  await db.database.query(
    'insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())',
    [outsider, `${outsider}@example.test`],
  );
  await insertArtifact(artifactId);
  await insertArtifact(otherArtifactId);
  await insertArtifact(privateArtifactId, { visibility: "private" });
  await insertArtifact(pptxArtifactId, { artifactType: "report" });

  // 1,203 shared rows over two collections, so one export crosses pages.
  await seed(artifactId, "shared", null, "scores", 1100);
  await seed(artifactId, "shared", null, "kv", 103);
  await seed(artifactId, "user", editor, "kv", 7, "e");
  await seed(artifactId, "user", viewer, "kv", 4, "v");
  await seed(artifactId, "user", viewer, "notes", 2, "n");
  await seed(otherArtifactId, "user", viewer, "kv", 3, "o");
  await seed(otherArtifactId, "shared", null, "kv", 3, "o");
}, 120_000);

afterAll(async () => {
  if (db) await db.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

const target = (
  scope: "user" | "shared",
  userId: string,
  options: { collection?: string; artifact?: string } = {},
) => ({
  workspaceId,
  artifactId: options.artifact ?? artifactId,
  userId,
  scope,
  collection: options.collection,
});

type ExportedDocument = {
  format: string;
  version: number;
  artifactId: string;
  scope: string;
  collection?: string;
  exportedAt: string;
  records: {
    scope: string;
    collection: string;
    id: string;
    data: { index: number; text: string };
    etag: string;
    createdAt: string;
    updatedAt: string;
  }[];
};

async function download(input: ReturnType<typeof target>) {
  const { filename, stream } = await service.export(input);
  const text = await new Response(stream).text();
  return { filename, text, document: JSON.parse(text) as ExportedDocument };
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ContentError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

async function auditRows(action: string) {
  const result = await db.database.query<{
    actor_user_id: string;
    target_id: string;
    metadata: Record<string, unknown>;
  }>(
    "select actor_user_id, target_id, metadata from team_audit_logs where team_id = $1 and action = $2 order by created_at",
    [teamId, action],
  );
  return result.rows;
}

test("an export is one valid JSON document, ordered by collection and id, across pages", async () => {
  const { filename, document } = await download(target("shared", creator));
  assert.equal(filename, `${artifactId}-shared-records.json`);
  assert.equal(document.format, "sourceweft.artifact-records");
  assert.equal(document.version, 1);
  assert.equal(document.artifactId, artifactId);
  assert.equal(document.scope, "shared");
  assert.equal(document.records.length, 1203);

  // 103 rows in "kv" then 1,100 in "scores", each in id order, no gaps and no
  // repeats where the 500-row pages meet.
  assert.deepEqual(
    document.records.slice(0, 103).map((record) => record.collection),
    Array(103).fill("kv"),
  );
  const keys = document.records.map(
    (record) => `${record.collection}/${record.id}`,
  );
  assert.equal(new Set(keys).size, 1203);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(document.records.at(-1)!.id, "r01099");

  assert.deepEqual(document.records[0], {
    scope: "shared",
    collection: "kv",
    id: "r00000",
    data: { index: 0, text: "value 0" },
    etag: "etag-0",
    createdAt: "2026-02-03T04:05:06.000Z",
    updatedAt: "2026-02-03T04:05:06.000Z",
  });
});

test("an export can be narrowed to one collection, and an empty one is still valid", async () => {
  const scores = await download(
    target("shared", creator, { collection: "scores" }),
  );
  assert.equal(scores.document.records.length, 1100);
  assert.equal(scores.document.collection, "scores");
  assert.equal(scores.filename, `${artifactId}-shared-scores-records.json`);

  const none = await download(
    target("shared", creator, { collection: "missing" }),
  );
  assert.deepEqual(none.document.records, []);
});

test("members export only their own user records", async () => {
  const mine = await download(target("user", viewer));
  assert.equal(mine.document.records.length, 6);
  assert.deepEqual(
    mine.document.records.map((record) => `${record.collection}/${record.id}`),
    [
      "kv/v00000",
      "kv/v00001",
      "kv/v00002",
      "kv/v00003",
      "notes/n00000",
      "notes/n00001",
    ],
  );
  assert.ok(mine.document.records.every((record) => record.scope === "user"));

  const editors = await download(target("user", editor));
  assert.equal(editors.document.records.length, 7);
  assert.ok(editors.document.records.every((r) => r.id.startsWith("e")));

  // A creator or admin has no records of their own, and never see anyone's.
  for (const userId of [creator, admin]) {
    const nothing = await download(target("user", userId));
    assert.deepEqual(nothing.document.records, [], userId);
  }
  // The other artifact's rows never leak into this one.
  assert.ok(!mine.document.records.some((record) => record.id.startsWith("o")));
});

test("shared data is for the creator or a content admin only", async () => {
  for (const userId of [editor, viewer]) {
    await rejectsWith(
      service.export(target("shared", userId)),
      "ARTIFACT_RECORD_FORBIDDEN",
    );
    await rejectsWith(
      service.clear(target("shared", userId)),
      "ARTIFACT_RECORD_FORBIDDEN",
    );
  }
  const asAdmin = await download(target("shared", admin));
  assert.equal(asAdmin.document.records.length, 1203);
});

test("unreachable artifacts look unavailable", async () => {
  await rejectsWith(
    service.export(target("user", outsider)),
    "ARTIFACT_RECORD_UNAVAILABLE",
  );
  await rejectsWith(
    service.export(target("shared", admin, { artifact: privateArtifactId })),
    "ARTIFACT_RECORD_UNAVAILABLE",
  );
  await rejectsWith(
    service.clear(target("user", viewer, { artifact: pptxArtifactId })),
    "ARTIFACT_RECORD_UNAVAILABLE",
  );
  await rejectsWith(
    service.clear(target("user", viewer, { artifact: randomUUID() })),
    "ARTIFACT_RECORD_UNAVAILABLE",
  );
});

test("exports and clears are audited with counts and never the data", async () => {
  const exported = await auditRows("artifact.records_exported");
  assert.ok(exported.length >= 3);
  const sharedExport = exported.find(
    (row) =>
      row.metadata.scope === "shared" &&
      row.metadata.collection === undefined &&
      row.actor_user_id === creator,
  );
  assert.ok(sharedExport);
  assert.equal(sharedExport.target_id, artifactId);
  assert.deepEqual(sharedExport.metadata, {
    scope: "shared",
    records: 1203,
    complete: true,
  });
  for (const row of exported)
    assert.ok(!JSON.stringify(row.metadata).includes("value "));
});

test("clearing removes only the caller's slice and reports the count", async () => {
  // One collection of the viewer's own data.
  assert.deepEqual(
    await service.clear(target("user", viewer, { collection: "notes" })),
    { removed: 2 },
  );
  assert.equal(
    (await download(target("user", viewer))).document.records.length,
    4,
  );

  // The editor's data, the shared data and the other artifact are untouched.
  assert.equal(
    (await download(target("user", editor))).document.records.length,
    7,
  );
  assert.equal(
    (await download(target("shared", creator))).document.records.length,
    1203,
  );

  // Everything the viewer has left, on this artifact only.
  assert.deepEqual(await service.clear(target("user", viewer)), { removed: 4 });
  assert.deepEqual(await service.clear(target("user", viewer)), { removed: 0 });
  assert.equal(
    (await download(target("user", viewer, { artifact: otherArtifactId })))
      .document.records.length,
    3,
  );

  // Shared data: one collection, then the rest.
  assert.deepEqual(
    await service.clear(target("shared", admin, { collection: "kv" })),
    { removed: 103 },
  );
  assert.deepEqual(await service.clear(target("shared", creator)), {
    removed: 1100,
  });
  assert.equal(
    (await download(target("shared", creator))).document.records.length,
    0,
  );
  assert.equal(
    (await download(target("shared", creator, { artifact: otherArtifactId })))
      .document.records.length,
    3,
  );

  const cleared = await auditRows("artifact.records_cleared");
  assert.deepEqual(
    cleared.map((row) => [row.actor_user_id, row.metadata]),
    [
      [viewer, { scope: "user", collection: "notes", removed: 2 }],
      [viewer, { scope: "user", removed: 4 }],
      [viewer, { scope: "user", removed: 0 }],
      [admin, { scope: "shared", collection: "kv", removed: 103 }],
      [creator, { scope: "shared", removed: 1100 }],
    ],
  );
});
