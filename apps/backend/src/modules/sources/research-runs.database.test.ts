import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

/** Issue #678: the research_runs table, its check constraints and cascade. */

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let schema: typeof import("@sourceweft/db");
const originalDatabaseUrl = process.env.DATABASE_URL;

let teamId: string;
let workspaceId: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("research_runs");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
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

const run = (overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  teamId,
  workspaceId,
  createdByUserId: "user-1",
  topic: "Solid-state batteries",
  ...overrides,
});

test("inserts a valid row with defaults", async () => {
  const values = run();
  await schema.db.insert(schema.sourceResearchRuns).values(values);
  const [row] = await schema.db
    .select()
    .from(schema.sourceResearchRuns)
    .where(eq(schema.sourceResearchRuns.id, values.id));
  assert.equal(row?.status, "queued");
  assert.deepEqual(row?.progressJson, {
    round: 0,
    searches: 0,
    pagesRead: 0,
    modelCalls: 0,
  });
  assert.deepEqual(row?.ledgerJson, []);
  assert.equal(row?.modelCalls, 0);
});

test("rejects a status outside the enum", async () => {
  await assert.rejects(
    schema.db
      .insert(schema.sourceResearchRuns)
      .values(run({ status: "bogus" })),
  );
});

test("rejects an error code outside the enum", async () => {
  await assert.rejects(
    schema.db
      .insert(schema.sourceResearchRuns)
      .values(run({ errorCode: "BOGUS" })),
  );
});

test("deleting the workspace cascades to its runs", async () => {
  const values = run();
  await schema.db.insert(schema.sourceResearchRuns).values(values);
  await schema.db
    .delete(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
  const rows = await schema.db
    .select()
    .from(schema.sourceResearchRuns)
    .where(eq(schema.sourceResearchRuns.id, values.id));
  assert.equal(rows.length, 0);
});
