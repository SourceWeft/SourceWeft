import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let db: typeof import("@sourceweft/db");
let navigation: typeof import("./navigation");
let service: import("./service").ArtifactRecordsService;
const originalDatabaseUrl = process.env.DATABASE_URL;

const teamId = randomUUID();
const otherTeamId = randomUUID();
const workspaceId = randomUUID();
const viewer = randomUUID();
const artifactId = randomUUID();
const otherArtifactId = randomUUID();
const v1 = randomUUID();
const v2 = randomUUID();
const otherVersion = randomUUID();
const DAY = 24 * 60 * 60 * 1000;

async function insertArtifact(id: string, versions: string[]) {
  await db.db.insert(db.artifacts).values({
    id,
    teamId,
    workspaceId,
    artifactType: "html",
    status: "ready",
    currentVersionNo: versions.length,
    visibility: "workspace",
    createdBy: viewer,
  });
  for (const [index, versionId] of versions.entries())
    await db.db.insert(db.artifactVersions).values({
      id: versionId,
      teamId,
      workspaceId,
      artifactId: id,
      versionNo: index + 1,
      createdBy: viewer,
      contentJson: {
        schemaVersion: 1,
        metadata: { schemaVersion: 1, capabilities: ["storage"] },
      },
    });
}

function audit(input: {
  team?: string;
  artifact?: string;
  version?: string;
  ageMs: number;
  action?: string;
}) {
  return db.db.insert(db.teamAuditLogs).values({
    id: randomUUID(),
    teamId: input.team ?? teamId,
    actorUserId: viewer,
    action: input.action ?? "artifact.page_navigation_attempt",
    targetType: "artifact",
    targetId: input.artifact ?? artifactId,
    metadata: { versionId: input.version ?? v1 },
    createdAt: new Date(Date.now() - input.ageMs),
  });
}

const count = (version = v1, artifact = artifactId, team = teamId) =>
  navigation.countNavigationAttempts({
    teamId: team,
    artifactId: artifact,
    versionId: version,
  });

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("artifact_nav");
  process.env.DATABASE_URL = isolated.url;
  db = await import("@sourceweft/db");
  navigation = await import("./navigation");
  const { ArtifactRecordsService } = await import("./service");
  service = new ArtifactRecordsService(
    { allow: async () => true },
    { allow: async () => true },
  );

  await db.database.query(
    'insert into organization (id,name,slug,"createdAt") values ($1,$1,$1,now())',
    [teamId],
  );
  await db.db.insert(db.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Navigation",
    slug: workspaceId,
  });
  await db.database.query(
    'insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())',
    [viewer, `${viewer}@example.test`],
  );
  await db.db.insert(db.workspaceMemberships).values({
    workspaceId,
    userId: viewer,
    role: "viewer",
    source: "guest",
  });
  await insertArtifact(artifactId, [v1, v2]);
  await insertArtifact(otherArtifactId, [otherVersion]);
}, 120_000);

afterAll(async () => {
  if (db) await db.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

test("only reports inside the last seven days for that exact version count", async () => {
  assert.equal(await count(), 0);
  await audit({ ageMs: 1000 });
  await audit({ ageMs: 6 * DAY });
  await audit({ ageMs: 7 * DAY + 60_000 });
  await audit({ ageMs: 30 * DAY });
  assert.equal(await count(), 2);
});

test("other versions, artifacts, teams and actions are not counted", async () => {
  await audit({ version: v2, ageMs: 1000 });
  await audit({
    artifact: otherArtifactId,
    version: otherVersion,
    ageMs: 1000,
  });
  // Same version id under another artifact or team does not leak in.
  await audit({ artifact: otherArtifactId, version: v1, ageMs: 1000 });
  await audit({ team: otherTeamId, ageMs: 1000 });
  await audit({ action: "artifact.storage_shared_approved", ageMs: 1000 });
  assert.equal(await count(), 2);
  assert.equal(await count(v2), 1);
  assert.equal(await count(otherVersion, otherArtifactId), 1);
  assert.equal(await count(v1, otherArtifactId), 1);
  assert.equal(await count(v1, artifactId, otherTeamId), 1);
});

test("a viewer's report is recorded and shows up in status", async () => {
  const before = await count(v2);
  const input = { workspaceId, artifactId, versionId: v2, userId: viewer };
  assert.deepEqual(await service.reportNavigation(input), { accepted: true });
  assert.equal(await count(v2), before + 1);
  const status = await service.status(input);
  assert.equal(status.navigationAttempts, before + 1);
  const rows = await db.database.query(
    "select metadata from team_audit_logs where action = $1 and metadata->>'versionId' = $2 order by created_at desc limit 1",
    ["artifact.page_navigation_attempt", v2],
  );
  assert.deepEqual(rows.rows[0].metadata, { versionId: v2 });
});
