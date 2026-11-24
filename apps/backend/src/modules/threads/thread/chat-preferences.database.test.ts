import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

let schema: typeof import("@sourceweft/db");
let repository: typeof import("./repository");
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
const teamId = randomUUID();
const workspaceId = randomUUID();
const threadId = randomUUID();
const ownerId = randomUUID();

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("thread_prefs");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repository = await import("./repository");
  await schema.database.query(
    'insert into organization (id, name, slug, "createdAt") values ($1,$1,$1,now())',
    [teamId],
  );
  await schema.database.query(
    'insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1,$1,$2,true,now(),now())',
    [ownerId, `${ownerId}@example.test`],
  );
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Chat preferences regression",
    slug: workspaceId,
  });
  await schema.db.insert(schema.threads).values({
    id: threadId,
    teamId,
    workspaceId,
    title: "Chat preferences regression",
    createdBy: ownerId,
  });
}, 120_000);

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

test("concurrent chat preference patches keep each other's fields", async () => {
  const scope = { threadId, teamId, workspaceId };
  // A new chat saves its web access and its checked skills at the same
  // moment. Each round flips both, so a patch that wrote back a stale copy of
  // the other field is visible in the stored result.
  for (let round = 0; round < 20; round += 1) {
    const webAccess = round % 2 === 0;
    const skillIds =
      round % 2 === 0
        ? ["builtin:html"]
        : ["builtin:html", "builtin:video-presentation"];

    await Promise.all([
      repository.updateThreadChatPreferencesRecord({
        ...scope,
        chatPreferences: { webAccess },
      }),
      repository.updateThreadChatPreferencesRecord({
        ...scope,
        chatPreferences: { skillIds },
      }),
    ]);

    const stored = await repository.findThreadRecord(scope);
    assert.equal(
      stored?.chatPreferences.webAccess,
      webAccess,
      `round ${round}`,
    );
    assert.deepEqual(
      stored?.chatPreferences.skillIds,
      skillIds,
      `round ${round}`,
    );
  }
});

test("a chat preference patch for a missing thread changes nothing", async () => {
  const updated = await repository.updateThreadChatPreferencesRecord({
    threadId: randomUUID(),
    teamId,
    workspaceId,
    chatPreferences: { webAccess: false },
  });
  assert.equal(updated, null);
});
