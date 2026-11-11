import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import {
  OWNER,
  PAGE_CHARS,
  TRIGGER,
  item,
  makeSetup,
  type IndexCall,
} from "./sync-test-support";

let schema: typeof import("@sourceweft/db");
let connectorRuntime: typeof import("./index");
let syncRunRepo: typeof import("./repository/sync-run");
let schedules: typeof import("./repository/schedule") &
  typeof import("./repository/schedule-occurrence");
let sources: typeof import("../sources/repository");
let indexing: typeof import("../sources/indexing-service");
let setup: ReturnType<typeof makeSetup>;
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("connector_quota");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  connectorRuntime = await import("./index");
  syncRunRepo = await import("./repository/sync-run");
  schedules = {
    ...(await import("./repository/schedule")),
    ...(await import("./repository/schedule-occurrence")),
  };
  sources = await import("../sources/repository");
  indexing = await import("../sources/indexing-service");
  setup = makeSetup({ schema, connectorRuntime, syncRunRepo, indexing });
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

beforeEach(() => {
  vi.restoreAllMocks();
});

test("an exhausted balance blocks before any provider traffic and keeps the connector healthy", async () => {
  const t = await setup({
    pagesOf: [[item("a")]],
    billing: { available: 0 },
  });
  const run = await t.sync();
  assert.equal(run.status, "blocked");
  assert.equal(run.errorCode, "PAGES_LIMIT_EXCEEDED");
  assert.equal(t.fake.discoverPages.mock.calls.length, 0);
  assert.equal(t.index.calls.length, 0);
  const connector = await t.connectorRow();
  assert.equal(connector.status, "active");
  assert.equal(connector.lastError, null);
  assert.equal(connector.syncBlock?.reason, "PAGES_LIMIT_EXCEEDED");
  assert.equal(connector.syncBlock?.runId, run.id);
});

test("running out mid-page stops at once, writes nothing for the blocked item, and resumes from the uncommitted page", async () => {
  const t = await setup({
    pagesOf: [[item("a")], [item("b"), item("c"), item("d")]],
    billing: { available: 2 },
  });
  const blocked = await t.sync();
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.indexedCount, 2);
  assert.equal(blocked.failedCount, 0);
  // d is never extracted: the run ends at c, the first item that did not fit.
  assert.deepEqual(
    t.fake.extract.mock.calls.map(([call]) => call.item.externalId),
    ["a", "b", "c"],
  );
  assert.equal(t.index.calls.length, 2);
  const afterBlock = await t.sourceRows();
  assert.deepEqual(afterBlock.map((row) => row.externalId).sort(), ["a", "b"]);
  const cursorAfterBlock = await t.cursor();
  assert.deepEqual(cursorAfterBlock?.pageCursorJson, { page: "2" });
  assert.equal(cursorAfterBlock?.committedCursorJson, null);
  assert.equal((await t.connectorRow()).status, "active");

  t.billing.pages.available = 10;
  const resumed = await t.sync();
  assert.equal(resumed.status, "succeeded");
  // b is already indexed and unchanged; only c and d are billed this time.
  assert.equal(resumed.indexedCount, 2);
  assert.equal(t.index.calls.length, 4);
  const cursorAfterResume = await t.cursor();
  assert.equal(cursorAfterResume?.pageCursorJson, null);
  assert.deepEqual(cursorAfterResume?.committedCursorJson, { history: "h1" });
  const connector = await t.connectorRow();
  assert.equal(connector.syncBlock, null);
  assert.equal(
    (await t.sourceRows()).every((row) => row.status === "indexed"),
    true,
  );
});

test("a settlement-time rejection blocks the run and the failed item is reprocessed, not skipped", async () => {
  const t = await setup({ pagesOf: [[item("a")]] });
  t.index.control.raceOnce = true;
  const blocked = await t.sync();
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.errorCode, "PAGES_LIMIT_EXCEEDED");
  const [failed] = await t.sourceRows();
  assert.equal(failed?.status, "failed");

  const retried = await t.sync();
  assert.equal(retried.status, "succeeded");
  assert.equal(retried.indexedCount, 1);
  assert.equal(t.index.calls.length, 2);
  const [indexed] = await t.sourceRows();
  assert.equal(indexed?.status, "indexed");
});

test("an item larger than the whole cycle allowance is skipped without stalling the items behind it", async () => {
  const t = await setup({
    pagesOf: [[item("huge", PAGE_CHARS * 6), item("small")]],
    billing: { available: 5, cycleCapacity: 5 },
  });
  const run = await t.sync();
  assert.equal(run.status, "succeeded");
  assert.equal(run.indexedCount, 1);
  const oversized = (run.metadataJson as { oversizedItems?: unknown[] })
    .oversizedItems;
  assert.deepEqual(oversized, [
    {
      externalId: "huge",
      title: "huge",
      requestedPages: 6,
      cycleCapacity: 5,
    },
  ]);
  const rows = await t.sourceRows();
  assert.deepEqual(
    rows.map((row) => row.externalId),
    ["small"],
  );
  assert.deepEqual(await t.cursor().then((row) => row?.committedCursorJson), {
    history: "h1",
  });
});

test("shadow billing never blocks", async () => {
  const t = await setup({
    pagesOf: [[item("a"), item("b")]],
    billing: { available: 0, cycleCapacity: 0, enforced: false },
  });
  // The stub indexer still drains a balance; give it room so only admission is
  // under test here.
  t.billing.pages.available = 0;
  vi.restoreAllMocks();
  const calls: IndexCall[] = [];
  vi.spyOn(
    indexing.SourceIndexingService.prototype,
    "indexSourceRevision",
  ).mockImplementation(async function (input) {
    calls.push({ sourceId: input.sourceId, userId: input.userId });
    await schema.db
      .update(schema.sources)
      .set({ status: "indexed" })
      .where(eq(schema.sources.id, input.sourceId));
    return {} as never;
  });
  const run = await t.sync();
  assert.equal(run.status, "succeeded");
  assert.equal(calls.length, 2);
});

test("ingestion is billed to the connector owner, not whoever triggered the run", async () => {
  const t = await setup({ pagesOf: [[item("a")]] });
  await t.sync();
  assert.deepEqual(
    t.index.calls.map((call) => call.userId),
    [OWNER],
  );
  assert.equal(t.resolveActor.mock.calls[0]?.[0].ownerUserId, OWNER);
  // Attribution of the created source still follows the trigger.
  const [row] = await t.sourceRows();
  assert.equal(row?.createdBy, TRIGGER);
});

test("a connector without a billable owner is blocked, not billed to anyone else", async () => {
  const t = await setup({ pagesOf: [[item("a")]], owner: null });
  const run = await t.sync();
  assert.equal(run.status, "blocked");
  assert.equal(run.errorCode, "CONNECTOR_BILLING_OWNER_UNAVAILABLE");
  assert.equal(t.fake.discoverPages.mock.calls.length, 0);
  assert.equal(t.index.calls.length, 0);
  assert.equal(
    (await t.connectorRow()).syncBlock?.reason,
    "CONNECTOR_BILLING_OWNER_UNAVAILABLE",
  );
});

test("a replayed job for a blocked run does not execute it again", async () => {
  const t = await setup({
    pagesOf: [[item("a")]],
    billing: { available: 0 },
  });
  const run = await t.sync();
  assert.equal(run.status, "blocked");
  const orchestrator = new connectorRuntime.ConnectorSyncOrchestrator(
    t.billing.port,
    new connectorRuntime.ConnectorRegistry([t.fake.adapter]),
    {
      getRuntimeToken: async () => "token",
    } as unknown as InstanceType<typeof connectorRuntime.ConnectorOAuthService>,
    t.resolveActor,
  );
  t.billing.pages.available = 10;
  const replay = await orchestrator.run({
    teamId: t.teamId,
    workspaceId: t.workspaceId,
    connectorId: t.connectorId,
    runId: run.id,
    userId: TRIGGER,
  });
  assert.equal(replay?.status, "blocked");
  assert.equal(t.fake.discoverPages.mock.calls.length, 0);
});

test("a quota-blocked scheduled occurrence is skipped without retry and keeps the schedule", async () => {
  const t = await setup({
    pagesOf: [[item("a")]],
    billing: { available: 0 },
  });
  const schedule = await schedules.putConnectorSchedule({
    teamId: t.teamId,
    workspaceId: t.workspaceId,
    connectorId: t.connectorId,
    enabled: true,
    intervalMinutes: 60,
  });
  await schema.db
    .update(schema.taskSchedules)
    .set({ nextDueAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.taskSchedules.id, schedule.id));
  await schedules.materializeDueConnectorSchedules({
    now: new Date(),
    limit: 25,
  });
  const [claimed] = await schedules.claimDispatchableConnectorOccurrences({
    now: new Date(),
    limit: 25,
  });
  assert.ok(claimed);
  const run = await syncRunRepo.createSyncRunRecord({
    teamId: t.teamId,
    workspaceId: t.workspaceId,
    connectorId: t.connectorId,
    triggerType: "scheduled",
    status: "queued",
  });
  await schedules.attachScheduleOccurrenceRun({
    occurrenceId: claimed.occurrence.id,
    runId: run.id,
  });
  await schedules.markScheduleOccurrenceQueued(claimed.occurrence.id);
  const orchestrator = new connectorRuntime.ConnectorSyncOrchestrator(
    t.billing.port,
    new connectorRuntime.ConnectorRegistry([t.fake.adapter]),
    {
      getRuntimeToken: async () => "token",
    } as unknown as InstanceType<typeof connectorRuntime.ConnectorOAuthService>,
    t.resolveActor,
  );
  const result = await orchestrator.run({
    teamId: t.teamId,
    workspaceId: t.workspaceId,
    connectorId: t.connectorId,
    runId: run.id,
    userId: "system",
  });
  assert.equal(result?.status, "blocked");
  const [occurrence] = await schema.db
    .select()
    .from(schema.scheduleOccurrences)
    .where(eq(schema.scheduleOccurrences.id, claimed.occurrence.id));
  assert.equal(occurrence?.status, "skipped");
  assert.equal(occurrence?.retryAt, null);
  assert.equal(occurrence?.lastError, "PAGES_LIMIT_EXCEEDED");
  const [after] = await schema.db
    .select()
    .from(schema.taskSchedules)
    .where(eq(schema.taskSchedules.id, schedule.id));
  assert.equal(after?.enabled, true);
  assert.equal(after?.retryAt, null);
});

test("a source left failed by an earlier sync is not treated as current", async () => {
  const t = await setup({ pagesOf: [[item("a")]] });
  // Simulate the legacy state: watermark recorded, index never completed.
  await sources.createSourceRecord({
    teamId: t.teamId,
    workspaceId: t.workspaceId,
    title: "a",
    contentText: "stale",
    createdBy: TRIGGER,
    ingestKind: "connector",
    sourceType: "connector",
    connectorId: t.connectorId,
    externalId: "a",
    externalUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
    status: "failed",
  });
  const run = await t.sync();
  assert.equal(run.status, "succeeded");
  assert.equal(run.indexedCount, 1);
  assert.equal(t.fake.extract.mock.calls.length, 1);
  const [row] = await t.sourceRows();
  assert.equal(row?.status, "indexed");
});

test("a quota-blocked connector resumes on its own once the owner has pages, schedule or not", async () => {
  const t = await setup({
    pagesOf: [[item("a")]],
    billing: { available: 0 },
  });
  assert.equal((await t.sync()).status, "blocked");
  const repo = await import("./repository/connector");
  const enqueue = vi.fn(async () => ({ id: "job" }));

  const blocked = await repo.findSourceConnectorRecord(t);
  const stillShort = await t.orchestrator.enqueueQuotaResumeRun({
    connector: blocked!,
    enqueue,
  });
  assert.deepEqual(stillShort, {
    queued: false,
    reason: "pages_unavailable",
  });
  assert.equal(enqueue.mock.calls.length, 0);
  const checked = await t.connectorRow();
  assert.ok(checked.syncBlock?.resumeCheckedAt);
  // The check just happened, so the next scheduler pass backs off.
  const due = await repo.listQuotaBlockedConnectorRecords({
    checkedBefore: new Date(Date.now() - 60_000),
    limit: 100,
  });
  assert.equal(
    due.some((row) => row.id === t.connectorId),
    false,
  );
  const later = await repo.listQuotaBlockedConnectorRecords({
    checkedBefore: new Date(Date.now() + 60_000),
    limit: 100,
  });
  assert.equal(
    later.some((row) => row.id === t.connectorId),
    true,
  );

  t.billing.pages.available = 5;
  const resumed = await t.orchestrator.enqueueQuotaResumeRun({
    connector: (await repo.findSourceConnectorRecord(t))!,
    enqueue,
  });
  assert.equal(resumed.queued, true);
  const [payload] = enqueue.mock.calls[0] as unknown as [
    { runId: string; userId: string },
  ];
  assert.equal(payload.userId, OWNER);
  const run = await t.orchestrator.run({
    ...t,
    runId: payload.runId,
    userId: OWNER,
  });
  assert.equal(run?.status, "succeeded");
  assert.equal(run?.triggerType, "backfill");
  assert.equal((await t.connectorRow()).syncBlock, null);
});

test("a targeted webhook run for other items keeps the quota block, so the blocked item still resumes", async () => {
  const t = await setup({
    pagesOf: [[item("a", PAGE_CHARS * 3), item("b")]],
    billing: { available: 2 },
  });
  const blocked = await t.sync();
  assert.equal(blocked.status, "blocked");
  assert.equal((await t.connectorRow()).syncBlock?.requestedPages, 3);

  // A webhook for b succeeds, but it never looked at a: the block must stay.
  const webhook = await t.sync("webhook", ["b"]);
  assert.equal(webhook.status, "succeeded");
  assert.equal(webhook.indexedCount, 1);
  const kept = await t.connectorRow();
  assert.equal(kept.syncBlock?.reason, "PAGES_LIMIT_EXCEEDED");
  assert.equal(kept.syncBlock?.runId, blocked.id);

  // An untargeted run covers a again, so it clears the block.
  t.billing.pages.available = 10;
  const full = await t.sync();
  assert.equal(full.status, "succeeded");
  assert.equal((await t.connectorRow()).syncBlock, null);
  assert.deepEqual(
    (await t.sourceRows()).map((row) => row.externalId).sort(),
    ["a", "b"],
  );
});

test("a quota-blocked connector resumes only once the blocked item fits", async () => {
  const t = await setup({
    pagesOf: [[item("a", PAGE_CHARS * 3)]],
    billing: { available: 2 },
  });
  assert.equal((await t.sync()).status, "blocked");
  const repo = await import("./repository/connector");
  const enqueue = vi.fn(async () => ({ id: "job" }));

  // 2 pages are available, but the blocked item needs 3: resuming now would
  // only re-extract it and block again.
  const tooFew = await t.orchestrator.enqueueQuotaResumeRun({
    connector: (await repo.findSourceConnectorRecord(t))!,
    enqueue,
  });
  assert.deepEqual(tooFew, { queued: false, reason: "pages_unavailable" });
  assert.equal(enqueue.mock.calls.length, 0);

  t.billing.pages.available = 3;
  const resumed = await t.orchestrator.enqueueQuotaResumeRun({
    connector: (await repo.findSourceConnectorRecord(t))!,
    enqueue,
  });
  assert.equal(resumed.queued, true);
});

test("a quota-blocked item that outgrew the cycle allowance does not hold the resume back", async () => {
  const t = await setup({
    pagesOf: [[item("a", PAGE_CHARS * 3)]],
    billing: { available: 2, cycleCapacity: 10 },
  });
  assert.equal((await t.sync()).status, "blocked");
  const repo = await import("./repository/connector");
  const enqueue = vi.fn(async () => ({ id: "job" }));

  // The plan shrank below the item's size: the run will skip it as oversized.
  t.billing.pages.cycleCapacity = 2;
  const resumed = await t.orchestrator.enqueueQuotaResumeRun({
    connector: (await repo.findSourceConnectorRecord(t))!,
    enqueue,
  });
  assert.equal(resumed.queued, true);
});

test("an item that grew past the cycle allowance keeps its indexed version through a reconciling scan", async () => {
  const pagesOf = [[item("doc"), item("other")]];
  const t = await setup({ pagesOf, reconcile: true });
  assert.equal((await t.sync()).status, "succeeded");

  const doc = pagesOf[0]![0]!;
  doc.body = "y".repeat(PAGE_CHARS * 6);
  doc.externalUpdatedAt = new Date("2026-09-02T00:00:00.000Z");
  t.billing.pages.available = 5;
  t.billing.pages.cycleCapacity = 5;
  const run = await t.sync();
  assert.equal(run.status, "succeeded");
  assert.deepEqual(
    (run.metadataJson as { oversizedItems?: Array<{ externalId: string }> })
      .oversizedItems?.map((entry) => entry.externalId),
    ["doc"],
  );
  const rows = await t.sourceRows();
  const kept = rows.find((row) => row.externalId === "doc");
  assert.equal(kept?.status, "indexed");
  assert.equal(kept?.contentText, "x".repeat(20));
  assert.equal(
    rows.find((row) => row.externalId === "other")?.status,
    "indexed",
  );
});
