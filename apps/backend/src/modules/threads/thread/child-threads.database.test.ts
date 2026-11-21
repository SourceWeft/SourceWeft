import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, test } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

let schema: typeof import("@sourceweft/db");
let repository: typeof import("./repository");
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
let teamId: string;
let workspaceId: string;
let owner: string;
let viewer: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("child_threads");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repository = await import("./repository");
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, owner, viewer] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Child threads",
    slug: workspaceId,
  });
  await schema.db.insert(schema.workspaceMemberships).values([
    { workspaceId, userId: owner, role: "editor", source: "guest" },
    { workspaceId, userId: viewer, role: "viewer", source: "guest" },
  ]);
});

afterEach(async () => {
  await schema.db
    .delete(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
});

afterAll(async () => {
  if (schema) await schema.database.end();
  await isolated?.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

async function createParent(visibility: "private" | "workspace" = "workspace") {
  return repository.createThreadRecord({
    teamId,
    workspaceId,
    title: "Parent",
    createdBy: owner,
    visibility,
  });
}

test("a thread persists its parent, persona, and origin and defaults to a top-level user thread", async () => {
  const parent = await createParent();
  assert.equal(parent.parentThreadId, null);
  assert.equal(parent.personaId, null);
  assert.equal(parent.origin, "user");
  assert.equal(parent.visibility, "workspace");

  const child = await repository.createThreadRecord({
    teamId,
    workspaceId,
    title: "Explore",
    createdBy: owner,
    visibility: "workspace",
    parentThreadId: parent.id,
    personaId: "explore",
    origin: "subagent",
  });
  const found = await repository.findThreadRecord({
    threadId: child.id,
    teamId,
    workspaceId,
  });
  assert.equal(found?.parentThreadId, parent.id);
  assert.equal(found?.personaId, "explore");
  assert.equal(found?.origin, "subagent");
});

test("the top-level list hides children and the child list returns them by parent", async () => {
  const parent = await createParent();
  const other = await createParent();
  const child = await repository.createThreadRecord({
    teamId,
    workspaceId,
    title: "Plan",
    createdBy: owner,
    visibility: "workspace",
    parentThreadId: parent.id,
    personaId: "plan",
  });

  const topLevel = await repository.listThreadRecordsByWorkspace({
    teamId,
    workspaceId,
    viewerUserId: viewer,
    limit: 10,
  });
  assert.deepEqual(
    topLevel.map((thread) => thread.id).sort(),
    [parent.id, other.id].sort(),
  );

  const children = await repository.listChildThreadRecords({
    teamId,
    workspaceId,
    viewerUserId: viewer,
    parentThreadIds: [parent.id, other.id],
  });
  assert.deepEqual(
    children.map((thread) => [thread.id, thread.parentThreadId]),
    [[child.id, parent.id]],
  );

  assert.deepEqual(
    await repository.listChildThreadRecords({
      teamId,
      workspaceId,
      viewerUserId: viewer,
      parentThreadIds: [],
    }),
    [],
  );
});

test("another member's private child stays hidden even under a shared parent", async () => {
  const parent = await createParent();
  const shared = await repository.createThreadRecord({
    teamId,
    workspaceId,
    title: "Shared child",
    createdBy: owner,
    visibility: "workspace",
    parentThreadId: parent.id,
    personaId: "general-purpose",
  });
  await repository.createThreadRecord({
    teamId,
    workspaceId,
    title: "Private child",
    createdBy: owner,
    visibility: "private",
    parentThreadId: parent.id,
    personaId: "general-purpose",
  });

  const forViewer = await repository.listChildThreadRecords({
    teamId,
    workspaceId,
    viewerUserId: viewer,
    parentThreadIds: [parent.id],
  });
  assert.deepEqual(
    forViewer.map((thread) => thread.id),
    [shared.id],
  );

  const forOwner = await repository.listChildThreadRecords({
    teamId,
    workspaceId,
    viewerUserId: owner,
    parentThreadIds: [parent.id],
  });
  assert.equal(forOwner.length, 2);
});

test("deleting the parent keeps the child and clears its parent link", async () => {
  const parent = await createParent();
  const child = await repository.createThreadRecord({
    teamId,
    workspaceId,
    title: "Orphaned",
    createdBy: owner,
    visibility: "workspace",
    parentThreadId: parent.id,
    personaId: "explore",
  });

  await schema.db
    .delete(schema.threads)
    .where(eq(schema.threads.id, parent.id));

  const found = await repository.findThreadRecord({
    threadId: child.id,
    teamId,
    workspaceId,
  });
  assert.equal(found?.id, child.id);
  assert.equal(found?.parentThreadId, null);
  assert.equal(found?.personaId, "explore");
});

async function createDelegateThread(parentId: string, createdBy: string) {
  return repository.createThreadRecord({
    teamId,
    workspaceId,
    title: "Delegated task",
    createdBy,
    visibility: "workspace",
    parentThreadId: parentId,
    personaId: "general-purpose",
    origin: "subagent",
  });
}

function findThread(threadId: string) {
  return repository.findThreadRecord({ threadId, teamId, workspaceId });
}

test("deleting a thread also deletes the sub-agent threads its task calls opened", async () => {
  const parent = await createParent();
  const ownDelegate = await createDelegateThread(parent.id, owner);
  // A shared thread's turn can be run by another member; the transcript still
  // belongs to the thread.
  const memberDelegate = await createDelegateThread(parent.id, viewer);
  const otherParent = await createParent();
  const otherDelegate = await createDelegateThread(otherParent.id, owner);

  const deleted = await repository.deleteThreadRecord({
    threadId: parent.id,
    teamId,
    workspaceId,
    viewerUserId: owner,
    isContentAdmin: false,
  });

  assert.equal(deleted, true);
  assert.equal(await findThread(parent.id), null);
  assert.equal(await findThread(ownDelegate.id), null);
  assert.equal(await findThread(memberDelegate.id), null);
  assert.equal((await findThread(otherParent.id))?.id, otherParent.id);
  assert.equal(
    (await findThread(otherDelegate.id))?.parentThreadId,
    otherParent.id,
  );
});

test("deleting a thread keeps a sub-agent thread a member created under it", async () => {
  const parent = await createParent();
  const created = await repository.createThreadRecord({
    teamId,
    workspaceId,
    title: "Explore",
    createdBy: owner,
    visibility: "workspace",
    parentThreadId: parent.id,
    personaId: "explore",
  });

  const deleted = await repository.deleteThreadRecord({
    threadId: parent.id,
    teamId,
    workspaceId,
    viewerUserId: owner,
    isContentAdmin: false,
  });

  assert.equal(deleted, true);
  const found = await findThread(created.id);
  assert.equal(found?.id, created.id);
  assert.equal(found?.parentThreadId, null);
  assert.equal(found?.origin, "user");
});

test("a delete the caller may not perform removes neither the thread nor its sub-agent threads", async () => {
  const parent = await createParent();
  const delegate = await createDelegateThread(parent.id, viewer);

  // A plain member may delete only threads they created.
  const deleted = await repository.deleteThreadRecord({
    threadId: parent.id,
    teamId,
    workspaceId,
    viewerUserId: viewer,
    isContentAdmin: false,
  });

  assert.equal(deleted, false);
  assert.equal((await findThread(parent.id))?.id, parent.id);
  assert.equal((await findThread(delegate.id))?.parentThreadId, parent.id);
});

test("deleting a sub-agent thread itself leaves its parent and siblings alone", async () => {
  const parent = await createParent();
  const first = await createDelegateThread(parent.id, owner);
  const second = await createDelegateThread(parent.id, owner);

  const deleted = await repository.deleteThreadRecord({
    threadId: first.id,
    teamId,
    workspaceId,
    viewerUserId: owner,
    isContentAdmin: false,
  });

  assert.equal(deleted, true);
  assert.equal(await findThread(first.id), null);
  assert.equal((await findThread(parent.id))?.id, parent.id);
  assert.equal((await findThread(second.id))?.parentThreadId, parent.id);
});
