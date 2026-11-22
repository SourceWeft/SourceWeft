import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

/** Issue #678: research admission against real research_runs rows. */

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let schema: typeof import("@sourceweft/db");
let admission: typeof import("./admission");
const originalDatabaseUrl = process.env.DATABASE_URL;

let teamId: string;
let workspaceId: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("research_admission");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  admission = await import("./admission");
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId] = [randomUUID(), randomUUID()];
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Research",
    slug: `research-${workspaceId}`,
  });
});

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

async function insertRuns(
  count: number,
  overrides: { userId?: string; status?: string; createdAt?: Date } = {},
) {
  const rows = Array.from({ length: count }, () => ({
    id: randomUUID(),
    teamId,
    workspaceId,
    createdByUserId: overrides.userId ?? "user-1",
    topic: "Solid-state batteries",
    status: (overrides.status ?? "ready") as never,
    ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
  }));
  await schema.db.insert(schema.sourceResearchRuns).values(rows);
}

const admit = (hasCredits = true, userId = "user-1") =>
  admission.admitResearch(
    { teamId, workspaceId, userId },
    {
      countRuns: admission.countResearchRuns,
      hasCredits: async () => hasCredits,
    },
  );

test("admits when nothing blocks", async () => {
  assert.deepEqual(await admit(), { ok: true });
});

test("rejects without credits", async () => {
  const result = await admit(false);
  assert.equal(result.ok === false && result.code, "INSUFFICIENT_CREDITS");
});

test("a running run blocks the same user", async () => {
  await insertRuns(1, { status: "running" });
  const result = await admit();
  assert.equal(result.ok === false && result.code, "CONCURRENCY_LIMIT");
});

test("a queued run blocks the same user", async () => {
  await insertRuns(1, { status: "queued" });
  const result = await admit();
  assert.equal(result.ok === false && result.code, "CONCURRENCY_LIMIT");
});

test("finished runs do not count as concurrent", async () => {
  await insertRuns(1, { status: "ready" });
  assert.deepEqual(await admit(), { ok: true });
});

test("three active runs by other users block the team", async () => {
  await insertRuns(1, { userId: "a", status: "running" });
  await insertRuns(1, { userId: "b", status: "running" });
  await insertRuns(1, { userId: "c", status: "queued" });
  const result = await admit(true, "user-1");
  assert.equal(result.ok === false && result.code, "CONCURRENCY_LIMIT");
});

test("another user's single active run does not block this user", async () => {
  await insertRuns(1, { userId: "other", status: "running" });
  assert.deepEqual(await admit(), { ok: true });
});

test("twenty runs in the last 24 hours hit the daily limit", async () => {
  await insertRuns(20);
  const result = await admit();
  assert.equal(result.ok === false && result.code, "DAILY_LIMIT");
});

test("runs older than 24 hours do not count toward the daily limit", async () => {
  await insertRuns(20, {
    createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
  });
  assert.deepEqual(await admit(), { ok: true });
});

test("credits are checked before concurrency", async () => {
  await insertRuns(1, { status: "running" });
  const result = await admit(false);
  assert.equal(result.ok === false && result.code, "INSUFFICIENT_CREDITS");
});
