import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, test } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

let schema: typeof import("@sourceweft/db");
let service: typeof import("../service").contentThreadService;
let repository: typeof import("./repository");
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
let teamId: string;
let workspaceId: string;
let owner: string;
let member: string;
let admin: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("thread_list_mgmt");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  ({ contentThreadService: service } = await import("../service"));
  repository = await import("./repository");
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
    name: "Thread list management",
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

const notFound = (error: { code?: string }) =>
  error.code === "THREAD_NOT_FOUND";

async function chat(userId: string, title: string, shared = false) {
  const { thread } = await service.createThread({ workspaceId, userId, title });
  if (shared) {
    await service.updateThreadVisibility({
      workspaceId,
      threadId: thread.id,
      userId,
      visibility: "workspace",
    });
  }
  return thread;
}

async function message(
  threadId: string,
  role: "user" | "assistant" | "system" | "tool",
  content: string,
) {
  await schema.db.insert(schema.messages).values({
    id: randomUUID(),
    teamId,
    workspaceId,
    threadId,
    role,
    content,
  });
}

async function listIds(userId: string, mode: { pinned?: boolean } = {}) {
  const listed = await service.listThreads({ workspaceId, userId, ...mode });
  return listed.items.map((thread) => thread.id);
}

async function search(userId: string, q: string) {
  return (await service.searchThreads({ workspaceId, userId, q })).items;
}

// ---------------------------------------------------------------- rename

test("the author renames a chat and the list shows the new title in place", async () => {
  const older = await chat(owner, "Older");
  const renamed = await chat(owner, "Before");
  const before = (await service.listThreads({ workspaceId, userId: owner }))
    .items;

  assert.deepEqual(
    await service.renameThread({
      workspaceId,
      threadId: older.id,
      userId: owner,
      title: "  After  ",
    }),
    { threadId: older.id, title: "After" },
  );

  const after = (await service.listThreads({ workspaceId, userId: owner }))
    .items;
  assert.deepEqual(
    after.map((thread) => thread.id),
    before.map((thread) => thread.id),
  );
  assert.equal(after.find((thread) => thread.id === older.id)?.title, "After");
  assert.equal(
    after.find((thread) => thread.id === renamed.id)?.title,
    "Before",
  );
});

test("another member cannot rename a shared chat but a workspace admin can", async () => {
  const shared = await chat(owner, "Shared", true);

  await assert.rejects(
    service.renameThread({
      workspaceId,
      threadId: shared.id,
      userId: member,
      title: "Hijacked",
    }),
    notFound,
  );
  await service.renameThread({
    workspaceId,
    threadId: shared.id,
    userId: admin,
    title: "Tidied",
  });
  const opened = await service.getThread({
    workspaceId,
    threadId: shared.id,
    userId: member,
  });
  assert.equal(opened.thread.title, "Tidied");
});

test("a sub-agent chat cannot be renamed on its own", async () => {
  const parent = await chat(owner, "Parent");
  const { thread: child } = await service.createThread({
    workspaceId,
    userId: owner,
    parentThreadId: parent.id,
    personaId: "explore",
  });

  await assert.rejects(
    service.renameThread({
      workspaceId,
      threadId: child.id,
      userId: owner,
      title: "Child",
    }),
    notFound,
  );
});

test("automatic titling does not overwrite a manual rename", async () => {
  const { thread } = await service.createThread({ workspaceId, userId: owner });
  const placeholder = thread.title;

  await service.renameThread({
    workspaceId,
    threadId: thread.id,
    userId: owner,
    title: "Mine",
  });
  const generated = await repository.updateThreadTitleIfMatches({
    threadId: thread.id,
    teamId,
    workspaceId,
    expectedTitles: [placeholder],
    title: "Generated",
  });

  assert.equal(generated, null);
  const opened = await service.getThread({
    workspaceId,
    threadId: thread.id,
    userId: owner,
  });
  assert.equal(opened.thread.title, "Mine");
});

// ------------------------------------------------------------------ pins

test("pins are personal and move a chat out of the pinner's main list only", async () => {
  const shared = await chat(owner, "Shared", true);
  const other = await chat(owner, "Other", true);

  assert.deepEqual(
    await service.setThreadPinned({
      workspaceId,
      threadId: shared.id,
      userId: owner,
      pinned: true,
    }),
    { threadId: shared.id, pinned: true },
  );

  assert.deepEqual(await listIds(owner), [other.id]);
  assert.deepEqual(await listIds(owner, { pinned: true }), [shared.id]);
  assert.deepEqual(new Set(await listIds(member)), new Set([shared.id, other.id]));
  assert.deepEqual(await listIds(member, { pinned: true }), []);

  await service.setThreadPinned({
    workspaceId,
    threadId: shared.id,
    userId: owner,
    pinned: false,
  });
  assert.deepEqual(new Set(await listIds(owner)), new Set([shared.id, other.id]));
  assert.deepEqual(await listIds(owner, { pinned: true }), []);
});

test("pinned chats are listed newest pin first and pinning twice is harmless", async () => {
  const first = await chat(owner, "First");
  const second = await chat(owner, "Second");

  for (const thread of [first, second, second]) {
    await service.setThreadPinned({
      workspaceId,
      threadId: thread.id,
      userId: owner,
      pinned: true,
    });
  }

  assert.deepEqual(await listIds(owner, { pinned: true }), [
    second.id,
    first.id,
  ]);
  const listed = await service.listThreads({
    workspaceId,
    userId: owner,
    pinned: true,
  });
  assert.equal(listed.nextCursor, null);
});

test("archiving hides a pinned chat and unarchiving brings it back pinned", async () => {
  const thread = await chat(owner, "Pinned");
  await service.setThreadPinned({
    workspaceId,
    threadId: thread.id,
    userId: owner,
    pinned: true,
  });

  await service.setThreadArchived({
    workspaceId,
    threadId: thread.id,
    userId: owner,
    archived: true,
  });
  assert.deepEqual(await listIds(owner, { pinned: true }), []);
  const archived = await service.listThreads({
    workspaceId,
    userId: owner,
    archived: true,
  });
  assert.deepEqual(
    archived.items.map((item) => item.id),
    [thread.id],
  );

  await service.setThreadArchived({
    workspaceId,
    threadId: thread.id,
    userId: owner,
    archived: false,
  });
  assert.deepEqual(await listIds(owner, { pinned: true }), [thread.id]);
  assert.deepEqual(await listIds(owner), []);
});

test("a pin disappears when its chat becomes private to someone else", async () => {
  const shared = await chat(owner, "Shared", true);
  await service.setThreadPinned({
    workspaceId,
    threadId: shared.id,
    userId: member,
    pinned: true,
  });

  await service.updateThreadVisibility({
    workspaceId,
    threadId: shared.id,
    userId: owner,
    visibility: "private",
  });

  assert.deepEqual(await listIds(member, { pinned: true }), []);
  assert.deepEqual(await search(member, "Shared"), []);
  await assert.rejects(
    service.setThreadPinned({
      workspaceId,
      threadId: shared.id,
      userId: member,
      pinned: false,
    }),
    notFound,
  );
});

test("a sub-agent chat cannot be pinned and deleting a chat removes its pins", async () => {
  const parent = await chat(owner, "Parent", true);
  const { thread: child } = await service.createThread({
    workspaceId,
    userId: owner,
    parentThreadId: parent.id,
    personaId: "plan",
  });
  await assert.rejects(
    service.setThreadPinned({
      workspaceId,
      threadId: child.id,
      userId: owner,
      pinned: true,
    }),
    notFound,
  );

  for (const userId of [owner, member]) {
    await service.setThreadPinned({
      workspaceId,
      threadId: parent.id,
      userId,
      pinned: true,
    });
  }
  await service.deleteThread({ workspaceId, threadId: parent.id, userId: owner });

  const pins = await schema.database.query<{ count: number }>(
    "select count(*)::int as count from thread_pins where thread_id = $1",
    [parent.id],
  );
  assert.equal(pins.rows[0]?.count, 0);
});

// ---------------------------------------------------------------- search

test("search finds chats by title and by user or assistant message text", async () => {
  const byTitle = await chat(owner, "Quarterly Budget review");
  const byMessage = await chat(owner, "Planning");
  await message(byMessage.id, "user", "What did we decide about the budget?");
  await message(
    byMessage.id,
    "assistant",
    "We agreed to cut the travel BUDGET by a tenth.",
  );
  await chat(owner, "Unrelated");

  const results = await search(owner, "budget");
  const byId = new Map(results.map((result) => [result.thread.id, result]));

  assert.equal(results.length, 2);
  assert.deepEqual(byId.get(byTitle.id)?.match, {
    kind: "title",
    snippet: "Quarterly Budget review",
  });
  assert.equal(byId.get(byMessage.id)?.match.kind, "message");
  // The newest matching message supplies the snippet.
  assert.equal(
    byId.get(byMessage.id)?.match.snippet,
    "We agreed to cut the travel BUDGET by a tenth.",
  );
});

test("search never returns a chat the viewer cannot see", async () => {
  const privateChat = await chat(owner, "Secret plan");
  await message(privateChat.id, "user", "secret details");
  const shared = await chat(owner, "Shared plan", true);

  assert.deepEqual(
    (await search(member, "plan")).map((result) => result.thread.id),
    [shared.id],
  );
  assert.deepEqual(await search(member, "secret"), []);
});

test("search includes archived chats and flags them", async () => {
  const thread = await chat(owner, "Old launch notes");
  await service.setThreadArchived({
    workspaceId,
    threadId: thread.id,
    userId: owner,
    archived: true,
  });

  const [result] = await search(owner, "launch");
  assert.equal(result?.thread.id, thread.id);
  assert.equal(result?.archived, true);
});

test("search wildcards match literally", async () => {
  const percent = await chat(owner, "Growth 50% target");
  await chat(owner, "Growth target");
  const underscore = await chat(owner, "file_name check");
  await chat(owner, "filename check");

  assert.deepEqual(
    (await search(owner, "%")).map((result) => result.thread.id),
    [percent.id],
  );
  assert.deepEqual(
    (await search(owner, "file_name")).map((result) => result.thread.id),
    [underscore.id],
  );
});

test("search ignores tool and system messages", async () => {
  const thread = await chat(owner, "Plain");
  await message(thread.id, "tool", "hidden-token in tool output");
  await message(thread.id, "system", "hidden-token in a system prompt");

  assert.deepEqual(await search(owner, "hidden-token"), []);
});
