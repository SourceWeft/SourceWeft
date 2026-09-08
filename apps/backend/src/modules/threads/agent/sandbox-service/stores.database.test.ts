import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { beforeAll, afterAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../../../test/isolated-database";

type Schema = typeof import("@sourceweft/db");
type Store = import("./stores").DrizzleSandboxStore;
let schema: Schema;
let first: Client, second: Client, a: Store, b: Store;
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const originalUrl = process.env.DATABASE_URL;
beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("sandbox_store");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  const { DrizzleSandboxStore } = await import("./stores");
  first = new Client({ connectionString: isolated.url });
  second = new Client({ connectionString: isolated.url });
  await Promise.all([first.connect(), second.connect()]);
  a = new DrizzleSandboxStore(drizzle(first, { schema, casing: "snake_case" }));
  b = new DrizzleSandboxStore(
    drizzle(second, { schema, casing: "snake_case" }),
  );
}, 120_000);
afterAll(async () => {
  try {
    await Promise.all([first?.end(), second?.end()]);
    await schema?.database.end();
    await isolated?.close();
  } finally {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }
});

async function fixture() {
  const context = {
    teamId: randomUUID(),
    workspaceId: randomUUID(),
    threadId: randomUUID(),
    userId: randomUUID(),
    messageId: randomUUID(),
    runId: randomUUID(),
  };
  await schema.db.insert(schema.workspaces).values({
    id: context.workspaceId,
    organizationId: context.teamId,
    name: "Sandbox state regression",
    slug: randomUUID(),
  });
  await schema.db.insert(schema.threads).values({
    id: context.threadId,
    workspaceId: context.workspaceId,
    teamId: context.teamId,
    title: "Sandbox state regression",
  });
  const input = {
    sandboxId: randomUUID(),
    provider: "synthetic-provider",
    providerSandboxId: randomUUID(),
    context,
    expiresAt: new Date(Date.now() + 60_000),
  };
  return input;
}

test("two PostgreSQL connections can create only one active instance for a thread", async () => {
  const one = await fixture();
  const two = {
    ...one,
    sandboxId: randomUUID(),
    providerSandboxId: randomUUID(),
  };
  const wins = await Promise.all([
    a.insertCreatingSandbox(one),
    b.insertCreatingSandbox(two),
  ]);
  assert.equal(wins.filter(Boolean).length, 1);
  const winner = wins[0] ? one : two;
  assert.equal(await a.markSandboxReady(winner), true);
  assert.equal(await b.markSandboxReady(winner), false);
  const current = await b.findLatestActiveThreadSandbox(one);
  assert.equal(current?.id, winner.sandboxId);
  assert.equal(current?.status, "ready");
});

test("expired instances cannot be renewed or revived while a new generation becomes ready", async () => {
  const one = await fixture();
  await a.insertCreatingSandbox(one);
  await a.markSandboxReady(one);
  assert.equal(
    await b.markSandboxExpired({ ...one, expectedStatus: "ready" }),
    true,
  );
  assert.equal(
    await a.touchSandbox({ ...one, expiresAt: new Date(Date.now() + 120_000) }),
    false,
  );
  assert.equal(await a.markSandboxReady(one), false);
  assert.equal(await a.markCreatingSandboxError(one), false);
  const two = {
    ...one,
    sandboxId: randomUUID(),
    providerSandboxId: randomUUID(),
  };
  assert.equal(await b.insertCreatingSandbox(two), true);
  await b.markSandboxReady(two);
  assert.equal(
    await a.markSandboxExpired({ ...one, expectedStatus: "ready" }),
    false,
  );
  assert.equal((await b.findLatestActiveThreadSandbox(one))?.id, two.sandboxId);
});

test("a stale missing-instance verdict cannot overwrite a concurrent renewal", async () => {
  const one = await fixture();
  await a.insertCreatingSandbox(one);
  await a.markSandboxReady(one);
  await schema.db
    .update(schema.agentSandboxes)
    .set({ updatedAt: new Date("2020-01-01T00:00:00Z") })
    .where(eq(schema.agentSandboxes.id, one.sandboxId));
  const observed = (await b.findLatestActiveThreadSandbox(one))!;
  await first.query("BEGIN");
  try {
    assert.equal(
      await a.touchSandbox({
        ...one,
        expiresAt: new Date(Date.now() + 120_000),
      }),
      true,
    );
    const invalidation = b.markSandboxExpired({
      ...one,
      expectedStatus: "ready",
      expectedUpdatedAt: observed.updatedAtToken,
    });
    await first.query("COMMIT");
    assert.equal(await invalidation, false);
  } catch (error) {
    await first.query("ROLLBACK");
    throw error;
  }
  assert.equal((await b.findLatestActiveThreadSandbox(one))?.status, "ready");
  assert.equal(
    await a.touchSandbox({ ...one, providerSandboxId: "other-generation" }),
    false,
  );
});

test("a late create completion cannot revive a creating row claimed as failed", async () => {
  const one = await fixture();
  await a.insertCreatingSandbox(one);
  const observed = (await a.findLatestActiveThreadSandbox(one))!;
  assert.equal(
    await b.markCreatingSandboxError({
      sandboxId: one.sandboxId,
      expectedUpdatedAt: observed.updatedAtToken,
    }),
    true,
  );
  assert.equal(await a.markSandboxReady(one), false);
  assert.equal(await a.findLatestActiveThreadSandbox(one), null);
});

test("conditional expiry preserves PostgreSQL microseconds within the same JavaScript millisecond", async () => {
  const one = await fixture();
  await a.insertCreatingSandbox(one);
  await a.markSandboxReady(one);
  await first.query(
    "update agent_sandboxes set updated_at = '2020-01-01T00:00:00.123456Z' where id = $1",
    [one.sandboxId],
  );
  const observed = (await a.findLatestActiveThreadSandbox(one))!;
  assert.ok(observed.updatedAtToken?.includes("123456"));
  await second.query(
    "update agent_sandboxes set updated_at = '2020-01-01T00:00:00.123789Z' where id = $1",
    [one.sandboxId],
  );
  const current = (await b.findLatestActiveThreadSandbox(one))!;
  assert.equal(current.updatedAt.getTime(), observed.updatedAt.getTime());
  assert.equal(
    await a.markSandboxExpired({
      ...one,
      expectedStatus: "ready",
      expectedUpdatedAt: observed.updatedAtToken,
    }),
    false,
  );
  assert.equal(
    await a.markSandboxExpired({
      ...one,
      expectedStatus: "ready",
      expectedUpdatedAt: current.updatedAtToken,
    }),
    true,
  );
});
