import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let db: typeof import("@sourceweft/db");
let pending: typeof import("./pending-shared-approval");
const originalDatabaseUrl = process.env.DATABASE_URL;

const teamId = randomUUID();
const workspaceId = randomUUID();
const editor = randomUUID();
const admin = randomUUID();
const viewer = randomUUID();
const outsider = randomUUID();

const unapproved = randomUUID();
const approved = randomUUID();
const revoked = randomUUID();
const storageOnly = randomUUID();
const plain = randomUUID();
const supersededByPlain = randomUUID();
const approvalOnOldVersion = randomUUID();
const notReady = randomUUID();
const otherType = randomUUID();

type VersionSpec = { id?: string; no: number; capabilities?: unknown };

async function insertArtifact(
  id: string,
  versions: VersionSpec[],
  options: { status?: "ready" | "failed"; type?: "html" | "image" } = {},
) {
  const rows = versions.map((version) => ({
    ...version,
    id: version.id ?? randomUUID(),
  }));
  await db.db.insert(db.artifacts).values({
    id,
    teamId,
    workspaceId,
    artifactType: options.type ?? "html",
    status: options.status ?? "ready",
    currentVersionNo: rows.at(-1)!.no,
    visibility: "workspace",
    createdBy: editor,
  });
  for (const version of rows)
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
  return rows.map((row) => row.id);
}

async function approve(
  artifactId: string,
  versionId: string,
  revokedAt: Date | null = null,
) {
  await db.db.insert(db.artifactCapabilityApprovals).values({
    versionId,
    artifactId,
    teamId,
    capability: "storage.shared",
    approvedBy: editor,
    revokedBy: revokedAt ? editor : null,
    revokedAt,
  });
}

const allIds = () => [
  unapproved,
  approved,
  revoked,
  storageOnly,
  plain,
  supersededByPlain,
  approvalOnOldVersion,
  notReady,
  otherType,
];

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("shared_approval");
  process.env.DATABASE_URL = isolated.url;
  db = await import("@sourceweft/db");
  pending = await import("./pending-shared-approval");

  await db.database.query(
    'insert into organization (id,name,slug,"createdAt") values ($1,$1,$1,now())',
    [teamId],
  );
  await db.db.insert(db.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Pending",
    slug: workspaceId,
  });
  for (const [userId, role] of [
    [editor, "editor"],
    [admin, "workspace_admin"],
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

  await insertArtifact(unapproved, [
    { no: 1, capabilities: ["storage.shared"] },
  ]);
  const [approvedVersion] = await insertArtifact(approved, [
    { no: 1, capabilities: ["storage", "storage.shared"] },
  ]);
  await approve(approved, approvedVersion!);
  const [revokedVersion] = await insertArtifact(revoked, [
    { no: 1, capabilities: ["storage.shared"] },
  ]);
  await approve(revoked, revokedVersion!, new Date());
  await insertArtifact(storageOnly, [{ no: 1, capabilities: ["storage"] }]);
  await insertArtifact(plain, [{ no: 1, capabilities: [] }]);
  // v1 asked for shared data, but the current version no longer does.
  await insertArtifact(supersededByPlain, [
    { no: 1, capabilities: ["storage.shared"] },
    { no: 2, capabilities: ["storage"] },
  ]);
  // Approval is per version: v1's approval says nothing about current v2.
  const [oldVersion] = await insertArtifact(approvalOnOldVersion, [
    { no: 1, capabilities: ["storage.shared"] },
    { no: 2, capabilities: ["storage.shared"] },
  ]);
  await approve(approvalOnOldVersion, oldVersion!);
  await insertArtifact(
    notReady,
    [{ no: 1, capabilities: ["storage.shared"] }],
    { status: "failed" },
  );
  await insertArtifact(
    otherType,
    [{ no: 1, capabilities: ["storage.shared"] }],
    { type: "image" },
  );
}, 120_000);

afterAll(async () => {
  if (db) await db.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

test("only current ready html versions that request shared data without an active approval wait", async () => {
  const waiting = await pending.findArtifactIdsAwaitingSharedApproval({
    teamId,
    workspaceId,
    artifactIds: allIds(),
  });
  assert.deepEqual(
    [...waiting].sort(),
    [unapproved, revoked, approvalOnOldVersion].sort(),
  );
});

test("an empty page and a foreign workspace match nothing", async () => {
  assert.equal(
    (
      await pending.findArtifactIdsAwaitingSharedApproval({
        teamId,
        workspaceId,
        artifactIds: [],
      })
    ).size,
    0,
  );
  assert.equal(
    (
      await pending.findArtifactIdsAwaitingSharedApproval({
        teamId,
        workspaceId: randomUUID(),
        artifactIds: allIds(),
      })
    ).size,
    0,
  );
});

test("approving clears the marker and revoking brings it back", async () => {
  const id = randomUUID();
  const [versionId] = await insertArtifact(id, [
    { no: 1, capabilities: ["storage.shared"] },
  ]);
  const check = async () =>
    (
      await pending.findPendingSharedApprovalArtifactIdsForViewer({
        teamId,
        workspaceId,
        userId: editor,
        artifactIds: [id],
      })
    ).has(id);
  assert.equal(await check(), true);
  await approve(id, versionId!);
  assert.equal(await check(), false);
  await db.db
    .update(db.artifactCapabilityApprovals)
    .set({ revokedAt: new Date(), revokedBy: editor })
    .where(eq(db.artifactCapabilityApprovals.versionId, versionId!));
  assert.equal(await check(), true);
});

test("the marker is only for callers who may approve", async () => {
  const forUser = async (userId: string) =>
    [
      ...(await pending.findPendingSharedApprovalArtifactIdsForViewer({
        teamId,
        workspaceId,
        userId,
        artifactIds: allIds(),
      })),
    ].sort();
  const expected = [unapproved, revoked, approvalOnOldVersion].sort();
  assert.deepEqual(await forUser(editor), expected);
  assert.deepEqual(await forUser(admin), expected);
  assert.deepEqual(await forUser(viewer), []);
  assert.deepEqual(await forUser(outsider), []);
});
