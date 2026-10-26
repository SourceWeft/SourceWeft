import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let db: typeof import("@sourceweft/db");
let listSharedCollections: typeof import("./shared-collections").listSharedCollections;
const originalDatabaseUrl = process.env.DATABASE_URL;

const teamId = randomUUID();
const workspaceId = randomUUID();
const author = randomUUID();
const artifactId = randomUUID();
const otherArtifactId = randomUUID();
const emptyArtifactId = randomUUID();

async function insertArtifact(id: string) {
  await db.db.insert(db.artifacts).values({
    id,
    teamId,
    workspaceId,
    artifactType: "html",
    status: "ready",
    currentVersionNo: 1,
    visibility: "workspace",
    createdBy: author,
  });
}

async function insertRecords(
  artifact: string,
  scope: "user" | "shared",
  collection: string,
  count: number,
) {
  for (let i = 0; i < count; i++) {
    await db.db.insert(db.artifactRecords).values({
      id: randomUUID(),
      teamId,
      workspaceId,
      artifactId: artifact,
      scope,
      ownerUserId: scope === "user" ? author : null,
      collection,
      recordId: `r${i}`,
      data: { i },
      sizeBytes: 8,
      etag: randomUUID().replaceAll("-", ""),
      createdBy: author,
      updatedBy: author,
    });
  }
}

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("shared_colls");
  process.env.DATABASE_URL = isolated.url;
  db = await import("@sourceweft/db");
  ({ listSharedCollections } = await import("./shared-collections"));

  await db.database.query(
    'insert into organization (id,name,slug,"createdAt") values ($1,$1,$1,now())',
    [teamId],
  );
  await db.db.insert(db.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Collections",
    slug: workspaceId,
  });
  await db.database.query(
    'insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())',
    [author, `${author}@example.test`],
  );
  await insertArtifact(artifactId);
  await insertArtifact(otherArtifactId);
  await insertArtifact(emptyArtifactId);

  await insertRecords(artifactId, "shared", "posts", 3);
  await insertRecords(artifactId, "shared", "comments", 1);
  await insertRecords(artifactId, "user", "drafts", 2);
  // A collection name that exists in both scopes counts only its shared rows.
  await insertRecords(artifactId, "user", "posts", 4);
  await insertRecords(otherArtifactId, "shared", "secrets", 5);
  await insertRecords(otherArtifactId, "shared", "posts", 7);
}, 120_000);

afterAll(async () => {
  if (db) await db.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

test("lists shared collections with record counts, sorted by name", async () => {
  assert.deepEqual(await listSharedCollections(artifactId), [
    { collection: "comments", count: 1 },
    { collection: "posts", count: 3 },
  ]);
});

test("never lists user-scope collections or counts user-scope rows", async () => {
  const names = (await listSharedCollections(artifactId)).map(
    (entry) => entry.collection,
  );
  assert.ok(!names.includes("drafts"));
  const posts = (await listSharedCollections(artifactId)).find(
    (entry) => entry.collection === "posts",
  );
  assert.equal(posts?.count, 3);
});

test("excludes other artifacts' data", async () => {
  const names = (await listSharedCollections(artifactId)).map(
    (entry) => entry.collection,
  );
  assert.ok(!names.includes("secrets"));
  assert.deepEqual(await listSharedCollections(otherArtifactId), [
    { collection: "posts", count: 7 },
    { collection: "secrets", count: 5 },
  ]);
});

test("an artifact without shared data has no collections", async () => {
  assert.deepEqual(await listSharedCollections(emptyArtifactId), []);
});
