import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, test } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

let schema: typeof import("@sourceweft/db");
let service: typeof import("../service").contentThreadService;
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
let teamId: string;
let workspaceId: string;
let owner: string;
let member: string;
let admin: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("thread_archive");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  ({ contentThreadService: service } = await import("../service"));
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, owner, member, admin] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  await schema.database.query(
    'insert into organization (id,name,slug,"createdAt") values ($1,$1,$1,now())',
    [teamId],
  );
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Thread archive",
    slug: workspaceId,
  });
  // A guest's role is capped below workspace_admin, so the admin is an
  // organization member with a direct workspace membership.
  await schema.database.query(
    'insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())',
    [admin, `${admin}@example.test`],
  );
  await schema.database.query(
    `insert into member (id, "organizationId", "userId", role, "createdAt") values ($1, $2, $1, 'member', now())`,
    [admin, teamId],
  );
  await schema.db.insert(schema.workspaceMemberships).values([
    { workspaceId, userId: owner, role: "editor", source: "guest" },
    { workspaceId, userId: member, role: "editor", source: "guest" },
    { workspaceId, userId: admin, role: "workspace_admin", source: "direct" },
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

async function listIds(userId: string, archived?: boolean) {
  const listed = await service.listThreads({ workspaceId, userId, archived });
  return listed.items.map((thread) => thread.id);
}

async function sharedThread(userId: string, title: string) {
  const { thread } = await service.createThread({ workspaceId, userId, title });
  await service.updateThreadVisibility({
    workspaceId,
    threadId: thread.id,
    userId,
    visibility: "workspace",
  });
  return thread;
}

test("an archived chat leaves the main list, is listed as archived, and comes back when unarchived", async () => {
  const { thread: kept } = await service.createThread({
    workspaceId,
    userId: owner,
    title: "Kept",
  });
  const { thread: archived } = await service.createThread({
    workspaceId,
    userId: owner,
    title: "Archived",
  });
  const { thread: child } = await service.createThread({
    workspaceId,
    userId: owner,
    parentThreadId: archived.id,
    personaId: "explore",
  });

  assert.deepEqual(
    await service.setThreadArchived({
      workspaceId,
      threadId: archived.id,
      userId: owner,
      archived: true,
    }),
    { threadId: archived.id, archived: true },
  );

  assert.deepEqual(await listIds(owner), [kept.id]);
  const archivedList = await service.listThreads({
    workspaceId,
    userId: owner,
    archived: true,
  });
  assert.deepEqual(
    archivedList.items.map((thread) => thread.id),
    [archived.id],
  );
  // Its sub-agent conversation stays nested under it.
  assert.deepEqual(
    archivedList.items[0]?.children?.map((thread) => thread.id),
    [child.id],
  );
  // An archived chat still opens.
  const opened = await service.getThread({
    workspaceId,
    threadId: archived.id,
    userId: owner,
  });
  assert.equal(opened.thread.id, archived.id);

  await service.setThreadArchived({
    workspaceId,
    threadId: archived.id,
    userId: owner,
    archived: false,
  });
  assert.deepEqual(new Set(await listIds(owner)), new Set([kept.id, archived.id]));
  assert.deepEqual(await listIds(owner, true), []);
});

test("archived chats page with a cursor like the main list", async () => {
  const ids: string[] = [];
  for (const title of ["One", "Two", "Three"]) {
    const { thread } = await service.createThread({
      workspaceId,
      userId: owner,
      title,
    });
    await service.setThreadArchived({
      workspaceId,
      threadId: thread.id,
      userId: owner,
      archived: true,
    });
    ids.push(thread.id);
  }

  const first = await service.listThreads({
    workspaceId,
    userId: owner,
    archived: true,
    limit: 2,
  });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const second = await service.listThreads({
    workspaceId,
    userId: owner,
    archived: true,
    limit: 2,
    cursor: first.nextCursor ?? undefined,
  });
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    new Set([...first.items, ...second.items].map((thread) => thread.id)),
    new Set(ids),
  );
});

test("only the author or a workspace admin may archive a shared chat", async () => {
  const shared = await sharedThread(owner, "Shared");

  await assert.rejects(
    service.setThreadArchived({
      workspaceId,
      threadId: shared.id,
      userId: member,
      archived: true,
    }),
    (error: { code?: string }) => error.code === "THREAD_NOT_FOUND",
  );
  assert.ok((await listIds(member)).includes(shared.id));

  await service.setThreadArchived({
    workspaceId,
    threadId: shared.id,
    userId: admin,
    archived: true,
  });
  // Archiving is per chat, not per viewer: it leaves everyone's main list.
  assert.equal((await listIds(member)).includes(shared.id), false);
  assert.deepEqual(await listIds(member, true), [shared.id]);
});

test("another member's private chat and a sub-agent chat cannot be archived", async () => {
  const { thread: privateThread } = await service.createThread({
    workspaceId,
    userId: owner,
    title: "Private",
  });
  const { thread: child } = await service.createThread({
    workspaceId,
    userId: owner,
    parentThreadId: privateThread.id,
    personaId: "plan",
  });

  // A workspace admin cannot reach a private chat that is not theirs.
  await assert.rejects(
    service.setThreadArchived({
      workspaceId,
      threadId: privateThread.id,
      userId: admin,
      archived: true,
    }),
    (error: { code?: string }) => error.code === "THREAD_NOT_FOUND",
  );
  // Sub-agent chats follow their parent and are never archived on their own.
  await assert.rejects(
    service.setThreadArchived({
      workspaceId,
      threadId: child.id,
      userId: owner,
      archived: true,
    }),
    (error: { code?: string }) => error.code === "THREAD_NOT_FOUND",
  );
  assert.deepEqual(await listIds(owner), [privateThread.id]);
  assert.deepEqual(await listIds(admin, true), []);
});
