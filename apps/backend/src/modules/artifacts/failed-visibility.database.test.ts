import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

let schema: typeof import("@sourceweft/db");
let artifacts: typeof import("./repository");
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
const teamId = randomUUID();
const workspaceId = randomUUID();
const askerId = randomUUID();
const peerId = randomUUID();
const ids = {
  ready: randomUUID(),
  askerFailed: randomUUID(),
  peerFailed: randomUUID(),
};

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("failed_visibility");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  artifacts = await import("./repository");
  await schema.database.query(
    'insert into organization (id, name, slug, "createdAt") values ($1,$1,$1,now())',
    [teamId],
  );
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Failed visibility",
    slug: workspaceId,
  });
  const rows = [
    { id: ids.ready, status: "ready" as const, createdBy: peerId },
    { id: ids.askerFailed, status: "failed" as const, createdBy: askerId },
    { id: ids.peerFailed, status: "failed" as const, createdBy: peerId },
  ];
  for (const row of rows) {
    await schema.db.insert(schema.artifacts).values({
      ...row,
      teamId,
      workspaceId,
      artifactType: "flashcards",
      visibility: "workspace",
    });
  }
}, 120_000);

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function listed(page: { items: readonly { id: string }[] }) {
  return new Set(page.items.map((item) => item.id));
}

test("a failed generation stays listed for the person who asked for it, and only for them", async () => {
  const scope = { teamId, workspaceId };
  for (const list of [
    artifacts.listArtifactRecords,
    artifacts.listArtifactSummaryRecords,
  ]) {
    const asker = listed(await list({ ...scope, viewerUserId: askerId }));
    assert.deepEqual(asker, new Set([ids.ready, ids.askerFailed]));

    const peer = listed(await list({ ...scope, viewerUserId: peerId }));
    assert.deepEqual(peer, new Set([ids.ready, ids.peerFailed]));

    // With no viewer, failures stay out.
    const anonymous = listed(await list(scope));
    assert.deepEqual(anonymous, new Set([ids.ready]));
  }
});
