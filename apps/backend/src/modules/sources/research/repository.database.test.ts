import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

/** Issue #678: research run repository against real research_runs rows. */

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let schema: typeof import("@sourceweft/db");
let repo: typeof import("./repository");
const originalDatabaseUrl = process.env.DATABASE_URL;

let teamId: string;
let workspaceId: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("res_repository");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repo = await import("./repository");
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

const create = (topic = "Solid-state batteries") =>
  repo.createRun({ teamId, workspaceId, userId: "user-1", topic });

test("a created run reads back as queued", async () => {
  const created = await create();
  assert.equal(created.status, "queued");
  const found = await repo.findRun({ teamId, workspaceId, id: created.id });
  assert.equal(found?.topic, "Solid-state batteries");
  assert.equal(found?.status, "queued");
  assert.equal(found?.createdByUserId, "user-1");
  assert.equal(
    await repo.findRun({ teamId, workspaceId: randomUUID(), id: created.id }),
    null,
  );
});

test("listRuns returns newest first within the workspace", async () => {
  const first = await create("one");
  const second = await create("two");
  const runs = await repo.listRuns({ teamId, workspaceId, limit: 10 });
  assert.deepEqual(
    runs.map((r) => r.id),
    [second.id, first.id],
  );
  assert.equal(
    (await repo.listRuns({ teamId, workspaceId, limit: 1 })).length,
    1,
  );
});

test("markRunning applies once", async () => {
  const run = await create();
  assert.equal(await repo.markRunning(run.id), true);
  assert.equal(await repo.markRunning(run.id), false);
  const found = await repo.findRun({ teamId, workspaceId, id: run.id });
  assert.equal(found?.status, "running");
  assert.ok(found?.startedAt);
});

test("saveProgress writes fields, keeps modelCalls monotonic", async () => {
  const run = await create();
  await repo.markRunning(run.id);
  const progress = { round: 1, searches: 2, pagesRead: 3, modelCalls: 5 };
  await repo.saveProgress(run.id, {
    phase: "searching",
    progress,
    plan: ["a", "b"],
    modelCalls: 5,
  });
  await repo.saveProgress(run.id, { modelCalls: 2 });
  const found = await repo.findRun({ teamId, workspaceId, id: run.id });
  assert.equal(found?.phase, "searching");
  assert.deepEqual(found?.progressJson, progress);
  assert.deepEqual(found?.planJson, ["a", "b"]);
  assert.equal(found?.modelCalls, 5);
});

test("saveProgress does not touch a terminal run", async () => {
  const run = await create();
  await repo.markRunning(run.id);
  await repo.finishCancelled(run.id);
  await repo.saveProgress(run.id, { plan: ["late"], modelCalls: 9 });
  const found = await repo.findRun({ teamId, workspaceId, id: run.id });
  assert.equal(found?.planJson, null);
  assert.equal(found?.modelCalls, 0);
});

test("requestCancel cancels a queued run directly", async () => {
  const run = await create();
  assert.equal(
    await repo.requestCancel({ teamId, workspaceId, id: run.id }),
    true,
  );
  const found = await repo.findRun({ teamId, workspaceId, id: run.id });
  assert.equal(found?.status, "cancelled");
  assert.ok(found?.finishedAt);
  assert.equal(await repo.isCancelRequested(run.id), true);
  assert.equal(
    await repo.requestCancel({ teamId, workspaceId, id: run.id }),
    false,
  );
});

test("requestCancel on a running run only flags it", async () => {
  const run = await create();
  await repo.markRunning(run.id);
  assert.equal(await repo.isCancelRequested(run.id), false);
  assert.equal(
    await repo.requestCancel({ teamId, workspaceId, id: run.id }),
    true,
  );
  const found = await repo.findRun({ teamId, workspaceId, id: run.id });
  assert.equal(found?.status, "running");
  assert.equal(found?.finishedAt, null);
  assert.equal(await repo.isCancelRequested(run.id), true);
});

test("requestCancel is scoped to the workspace and ignores finished runs", async () => {
  const run = await create();
  assert.equal(
    await repo.requestCancel({ teamId, workspaceId: randomUUID(), id: run.id }),
    false,
  );
  await repo.markRunning(run.id);
  await repo.finishReady(run.id, { report: "r", citations: [] });
  assert.equal(
    await repo.requestCancel({ teamId, workspaceId, id: run.id }),
    false,
  );
});

test("finishReady stores the report and is final", async () => {
  const run = await create();
  await repo.markRunning(run.id);
  assert.equal(
    await repo.finishReady(run.id, { report: "# R", citations: [] }),
    true,
  );
  const found = await repo.findRun({ teamId, workspaceId, id: run.id });
  assert.equal(found?.status, "ready");
  assert.equal(found?.reportMarkdown, "# R");
  assert.deepEqual(found?.reportCitationsJson, []);
  assert.ok(found?.finishedAt);
  assert.equal(
    await repo.finishFailed(run.id, "WEB_PROVIDER_UNAVAILABLE"),
    false,
  );
  assert.equal(await repo.finishCancelled(run.id), false);
});

test("finishReady does not apply to a cancelled run", async () => {
  const run = await create();
  await repo.requestCancel({ teamId, workspaceId, id: run.id });
  assert.equal(
    await repo.finishReady(run.id, { report: "x", citations: [] }),
    false,
  );
  const found = await repo.findRun({ teamId, workspaceId, id: run.id });
  assert.equal(found?.status, "cancelled");
  assert.equal(found?.reportMarkdown, null);
});

test("finishFailed records the error code", async () => {
  const run = await create();
  await repo.markRunning(run.id);
  assert.equal(
    await repo.finishFailed(run.id, "WEB_PROVIDER_UNAVAILABLE"),
    true,
  );
  const found = await repo.findRun({ teamId, workspaceId, id: run.id });
  assert.equal(found?.status, "failed");
  assert.equal(found?.errorCode, "WEB_PROVIDER_UNAVAILABLE");
});
