import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, test } from "vitest";
import { eq } from "drizzle-orm";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

let schema: typeof import("@sourceweft/db");
let repository: typeof import("./repository");
let artifactRepository: typeof import("../../artifacts/repository");
let shares: typeof import("../../sharing/store");
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
let teamId: string;
let workspaceId: string;
let threadId: string;
let artifactId: string;
let ownerId: string;
let peerId: string;
let token: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("thread_vis");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repository = await import("./repository");
  artifactRepository = await import("../../artifacts/repository");
  shares = await import("../../sharing/store");
}, 120_000);

beforeEach(async () => {
  teamId = randomUUID();
  workspaceId = randomUUID();
  threadId = randomUUID();
  artifactId = randomUUID();
  ownerId = randomUUID();
  peerId = randomUUID();
  token = randomUUID();
  await schema.database.query(
    'insert into organization (id, name, slug, "createdAt") values ($1,$1,$1,now())',
    [teamId],
  );
  for (const actor of [ownerId, peerId]) {
    await schema.database.query(
      'insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1,$1,$2,true,now(),now())',
      [actor, `${actor}@example.test`],
    );
  }
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Visibility regression",
    slug: workspaceId,
  });
  await schema.db.insert(schema.workspaceMemberships).values(
    [ownerId, peerId].map((userId) => ({
      workspaceId,
      userId,
      role: "editor" as const,
      source: "guest" as const,
    })),
  );
  await schema.db.insert(schema.threads).values({
    id: threadId,
    teamId,
    workspaceId,
    title: "Visibility regression",
    visibility: "workspace",
    createdBy: ownerId,
  });
  await schema.db.insert(schema.artifacts).values({
    id: artifactId,
    teamId,
    workspaceId,
    threadId,
    artifactType: "image",
    status: "ready",
    visibility: "workspace",
    createdBy: ownerId,
  });
  await schema.db.insert(schema.shareLinks).values({
    id: randomUUID(),
    teamId,
    workspaceId,
    targetType: "artifact",
    targetId: artifactId,
    token,
    isPublic: true,
    createdBy: ownerId,
  });
});

afterEach(async () => {
  if (!schema) return;
  await schema.database.query(
    "drop trigger if exists visibility_test_barrier on artifacts",
  );
  await schema.database.query(
    "drop function if exists visibility_test_barrier()",
  );
  await schema.db
    .delete(schema.shareLinks)
    .where(eq(schema.shareLinks.teamId, teamId));
  await schema.db
    .delete(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
  await schema.database.query("delete from organization where id = $1", [
    teamId,
  ]);
  await schema.database.query('delete from "user" where id = any($1::text[])', [
    [ownerId, peerId],
  ]);
});

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function change(visibility: "private" | "workspace", overrides = {}) {
  return repository.updateThreadVisibilityRecord({
    threadId,
    teamId,
    workspaceId,
    viewerUserId: ownerId,
    visibility,
    ...overrides,
  });
}

async function visibility() {
  const result = await schema.database.query<{
    thread_visibility: string;
    artifact_visibility: string;
    revoked_at: Date | null;
  }>(
    `select t.visibility as thread_visibility, a.visibility as artifact_visibility,
            s.revoked_at
       from threads t join artifacts a on a.thread_id = t.id
       join share_links s on s.target_id = a.id and s.token = $2
      where t.id = $1`,
    [threadId, token],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0]!;
}

async function installArtifactTrigger(body: string) {
  await schema.database.query(`
    create function visibility_test_barrier() returns trigger language plpgsql as $$
    begin
      ${body}
      return new;
    end $$;
    create trigger visibility_test_barrier before update of visibility on artifacts
      for each row execute function visibility_test_barrier();
  `);
}

async function waitForBlockedQuery(pattern: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await schema.database.query(
      `select 1 from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query ilike $1 and pid <> pg_backend_pid()`,
      [pattern],
    );
    if (result.rowCount) return;
    await delay(10);
  }
  assert.fail(`Expected a real PostgreSQL lock wait for ${pattern}`);
}

test("opposite visibility updates serialize through artifact inheritance", async () => {
  // Pause A at the last write: B must still wait for A's thread row lock.
  // Testing the lock state, rather than an arbitrary sleep, fixes the interleaving.
  const barrierKey = 289;
  await installArtifactTrigger(`
    if new.visibility = 'workspace' then
      perform pg_advisory_xact_lock(${barrierKey});
    end if;
  `);
  const blocker = await schema.database.connect();
  const requests: Promise<unknown>[] = [];
  try {
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock($1)", [barrierKey]);
    requests.push(change("workspace"));
    await waitForBlockedQuery("%update%artifacts%");
    requests.push(change("private"));
    await waitForBlockedQuery("%update%threads%");
    const during = await visibility();
    assert.equal(during.thread_visibility, "workspace");
    assert.equal(during.artifact_visibility, "workspace");
    assert.equal(during.revoked_at, null);
    await blocker.query("commit");
    await Promise.all(requests);
  } finally {
    await blocker.query("rollback");
    blocker.release();
    await Promise.allSettled(requests);
  }
  const after = await visibility();
  assert.equal(after.thread_visibility, "private");
  assert.equal(after.artifact_visibility, "private");
  assert.ok(after.revoked_at);
  const visibleToPeer = await artifactRepository.listArtifactRecords({
    teamId,
    workspaceId,
    viewerUserId: peerId,
  });
  assert.equal(visibleToPeer.items.length, 0);
  assert.equal(await shares.findLiveShareByToken(token), null);
});

test("an artifact write failure rolls back the thread and public-share revocation", async () => {
  await installArtifactTrigger(
    "raise exception 'visibility regression injected failure';",
  );
  await assert.rejects(() => change("private"), (error: unknown) => {
    // Drizzle wraps the PostgreSQL exception as the failed query's cause.
    for (let cause = error; cause instanceof Error; cause = cause.cause) {
      if (cause.message.includes("visibility regression injected failure"))
        return true;
    }
    return false;
  });
  assert.deepEqual(await visibility(), {
    thread_visibility: "workspace",
    artifact_visibility: "workspace",
    revoked_at: null,
  });
  assert.ok(await shares.findLiveShareByToken(token));
});

test("non-owner and mismatched tenant scopes cannot change any visibility", async () => {
  for (const overrides of [
    { viewerUserId: peerId },
    { teamId: randomUUID() },
    { workspaceId: randomUUID() },
  ]) {
    assert.equal(await change("private", overrides), null);
    assert.deepEqual(await visibility(), {
      thread_visibility: "workspace",
      artifact_visibility: "workspace",
      revoked_at: null,
    });
  }
});

test("re-sharing restores internal visibility without reviving the old public token", async () => {
  const hidden = await change("private");
  assert.ok(hidden);
  assert.deepEqual(hidden.revokedArtifactIds, [artifactId]);
  assert.equal(await shares.findLiveShareByToken(token), null);
  const restored = await change("workspace");
  assert.ok(restored);
  assert.deepEqual(restored.revokedArtifactIds, []);
  const state = await visibility();
  assert.equal(state.thread_visibility, "workspace");
  assert.equal(state.artifact_visibility, "workspace");
  assert.ok(state.revoked_at);
  assert.equal(await shares.findLiveShareByToken(token), null);
});
