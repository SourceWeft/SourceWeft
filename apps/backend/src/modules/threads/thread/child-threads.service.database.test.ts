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
let viewer: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("child_svc");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  ({ contentThreadService: service } = await import("../service"));
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
    name: "Child thread service",
    slug: workspaceId,
  });
  await schema.db.insert(schema.workspaceMemberships).values([
    { workspaceId, userId: owner, role: "editor", source: "guest" },
    { workspaceId, userId: viewer, role: "editor", source: "guest" },
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

test("a persona child thread is titled after the persona and nests under its parent", async () => {
  const { thread: parent } = await service.createThread({
    workspaceId,
    userId: owner,
    title: "Multi agent proofs",
  });
  const { thread: child } = await service.createThread({
    workspaceId,
    userId: owner,
    parentThreadId: parent.id,
    personaId: "explore",
  });

  assert.equal(child.title, "Explore");
  assert.equal(child.parentThreadId, parent.id);
  assert.equal(child.personaId, "explore");
  assert.equal(child.origin, "user");
  assert.equal(child.visibility, parent.visibility);

  const listed = await service.listThreads({ workspaceId, userId: owner });
  assert.deepEqual(
    listed.items.map((thread) => thread.id),
    [parent.id],
  );
  assert.deepEqual(
    listed.items[0]?.children?.map((thread) => thread.id),
    [child.id],
  );

  const children = await service.listChildThreads({
    workspaceId,
    threadId: parent.id,
    userId: owner,
  });
  assert.deepEqual(
    children.items.map((thread) => thread.id),
    [child.id],
  );
});

test("a child inherits a shared parent's audience but never a public link", async () => {
  const { thread: parent } = await service.createThread({
    workspaceId,
    userId: owner,
    title: "Shared",
  });
  await service.updateThreadVisibility({
    workspaceId,
    threadId: parent.id,
    userId: owner,
    visibility: "workspace",
  });
  const { thread: child } = await service.createThread({
    workspaceId,
    userId: viewer,
    parentThreadId: parent.id,
    personaId: "plan",
    title: "Plan the proof",
  });
  assert.equal(child.visibility, "workspace");
  assert.equal(child.title, "Plan the proof");
  assert.equal(child.createdBy, viewer);
});

test("nesting stops at one level and unknown personas or parents are rejected", async () => {
  const { thread: parent } = await service.createThread({
    workspaceId,
    userId: owner,
  });
  const { thread: child } = await service.createThread({
    workspaceId,
    userId: owner,
    parentThreadId: parent.id,
    personaId: "general-purpose",
  });

  await assert.rejects(
    service.createThread({
      workspaceId,
      userId: owner,
      parentThreadId: child.id,
      personaId: "explore",
    }),
    (error: { code?: string }) => error.code === "THREAD_NESTING_TOO_DEEP",
  );
  await assert.rejects(
    service.createThread({
      workspaceId,
      userId: owner,
      personaId: "not-a-persona",
    }),
    (error: { code?: string }) => error.code === "PERSONA_NOT_FOUND",
  );
  // A private parent another member cannot see is reported as missing.
  await assert.rejects(
    service.createThread({
      workspaceId,
      userId: viewer,
      parentThreadId: parent.id,
      personaId: "explore",
    }),
    (error: { code?: string }) => error.code === "THREAD_NOT_FOUND",
  );
});

test("the persona roster lists the built-in delegates for any workspace member", async () => {
  const { items } = await service.listPersonas({ workspaceId, userId: viewer });
  assert.deepEqual(
    items.map((persona) => persona.slug),
    ["general-purpose", "explore", "plan"],
  );
  assert.deepEqual(items[1]?.toolAllowlist, ["search_sources"]);
  assert.equal(items[0]?.toolAllowlist, null);
  assert.equal(items[0]?.trust, "system");
});
