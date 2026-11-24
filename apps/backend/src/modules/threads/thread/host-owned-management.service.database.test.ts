import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, test } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

/**
 * A workspace assistant's own conversations (its Router work log and its
 * tickets' worker conversations) are run by the assistant: deleting,
 * archiving or re-scoping one would break it, so even their creator and a
 * workspace admin are refused (403 `THREAD_HOST_OWNED`). Renaming stays
 * allowed.
 */

let schema: typeof import("@sourceweft/db");
let service: typeof import("../service").contentThreadService;
let createThreadRecord: typeof import("./repository").createThreadRecord;
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
let teamId: string;
let workspaceId: string;
let creator: string;
let admin: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("thread_host");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  ({ contentThreadService: service } = await import("../service"));
  ({ createThreadRecord } = await import("./repository"));
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, creator, admin] = [
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
    name: "Host-owned threads",
    slug: workspaceId,
  });
  await schema.database.query(
    'insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())',
    [admin, `${admin}@example.test`],
  );
  await schema.database.query(
    `insert into member (id, "organizationId", "userId", role, "createdAt") values ($1, $2, $1, 'member', now())`,
    [admin, teamId],
  );
  await schema.db.insert(schema.workspaceMemberships).values([
    { workspaceId, userId: creator, role: "editor", source: "guest" },
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

async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    const { statusCode, code } = error as {
      statusCode?: number;
      code?: string;
    };
    return `${statusCode} ${code}`;
  }
}

async function hostOwnedThread(
  origin: "assistant_router" | "assistant_ticket",
) {
  const thread = await createThreadRecord({
    teamId,
    workspaceId,
    title: "Workspace assistant",
    createdBy: creator,
    visibility: "workspace",
    origin,
  });
  return thread.id;
}

async function threadRow(threadId: string) {
  const [row] = await schema.db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.id, threadId));
  return row ?? null;
}

for (const origin of ["assistant_router", "assistant_ticket"] as const) {
  test(`deleting an ${origin} conversation is refused with THREAD_HOST_OWNED, for its creator and a workspace admin alike`, async () => {
    const threadId = await hostOwnedThread(origin);
    for (const userId of [creator, admin]) {
      assert.equal(
        await refusal(() =>
          service.deleteThread({ workspaceId, threadId, userId }),
        ),
        "403 THREAD_HOST_OWNED",
      );
    }
    assert.ok(await threadRow(threadId));
  });

  test(`archiving an ${origin} conversation is refused with THREAD_HOST_OWNED`, async () => {
    const threadId = await hostOwnedThread(origin);
    for (const userId of [creator, admin]) {
      assert.equal(
        await refusal(() =>
          service.setThreadArchived({
            workspaceId,
            threadId,
            userId,
            archived: true,
          }),
        ),
        "403 THREAD_HOST_OWNED",
      );
    }
    assert.equal((await threadRow(threadId))!.archived, false);
  });

  test(`changing an ${origin} conversation's visibility is refused with THREAD_HOST_OWNED`, async () => {
    const threadId = await hostOwnedThread(origin);
    assert.equal(
      await refusal(() =>
        service.updateThreadVisibility({
          workspaceId,
          threadId,
          userId: creator,
          visibility: "private",
        }),
      ),
      "403 THREAD_HOST_OWNED",
    );
    assert.equal((await threadRow(threadId))!.visibility, "workspace");
  });

  test(`an ${origin} conversation can still be renamed`, async () => {
    const threadId = await hostOwnedThread(origin);
    const renamed = await service.renameThread({
      workspaceId,
      threadId,
      userId: creator,
      title: "Our assistant",
    });
    assert.equal(renamed.title, "Our assistant");
    assert.equal((await threadRow(threadId))!.title, "Our assistant");
  });
}

test("a host-owned conversation the caller cannot see stays a 404, not a 403", async () => {
  const threadId = await createThreadRecord({
    teamId,
    workspaceId,
    title: "Private ticket",
    createdBy: creator,
    visibility: "private",
    origin: "assistant_ticket",
  }).then((thread) => thread.id);
  const outsider = randomUUID();
  await schema.db
    .insert(schema.workspaceMemberships)
    .values({ workspaceId, userId: outsider, role: "editor", source: "guest" });
  assert.equal(
    await refusal(() =>
      service.deleteThread({ workspaceId, threadId, userId: outsider }),
    ),
    "404 THREAD_NOT_FOUND",
  );
});

test("an ordinary conversation is still deleted, archived and re-scoped as before", async () => {
  const { thread } = await service.createThread({
    workspaceId,
    userId: creator,
    title: "Ordinary",
  });
  await service.updateThreadVisibility({
    workspaceId,
    threadId: thread.id,
    userId: creator,
    visibility: "workspace",
  });
  await service.setThreadArchived({
    workspaceId,
    threadId: thread.id,
    userId: creator,
    archived: true,
  });
  await service.deleteThread({
    workspaceId,
    threadId: thread.id,
    userId: creator,
  });
  assert.equal(await threadRow(thread.id), null);
});
