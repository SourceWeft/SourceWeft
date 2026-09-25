import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";
import type { ContentBillingPort } from "../../content/billing-port";
import type { ConnectorAdapter } from "../types";
import { ConnectorError } from "../errors";
import { createCoreBillingRuntime } from "../../../billing-host/core";

let schema: typeof import("@sourceweft/db");
let schedules: typeof import("./schedule") &
  typeof import("./schedule-occurrence");
let syncState: typeof import("./sync-state");
let connectorRepo: typeof import("./connector");
let syncRunRepo: typeof import("./sync-run");
let syncLock: typeof import("./sync-lock");
let connectorRuntime: typeof import("../index");
let retrievalRepo: typeof import("../../sources/retrieval-repository");
let scheduler: typeof import("../../../scheduler/schedules/connectors");
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("connector_sched");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  schedules = {
    ...(await import("./schedule")),
    ...(await import("./schedule-occurrence")),
  };
  syncState = await import("./sync-state");
  connectorRepo = await import("./connector");
  syncRunRepo = await import("./sync-run");
  syncLock = await import("./sync-lock");
  connectorRuntime = await import("../index");
  retrievalRepo = await import("../../sources/retrieval-repository");
  scheduler = await import("../../../scheduler/schedules/connectors");
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

async function connector() {
  const teamId = randomUUID();
  const workspaceId = randomUUID();
  const connectorId = randomUUID();
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Schedule test",
    slug: workspaceId,
  });
  await schema.db.insert(schema.sourceConnectors).values({
    id: connectorId,
    teamId,
    workspaceId,
    connectorType: "notion",
    name: connectorId,
  });
  return { teamId, workspaceId, connectorId };
}

test("creating a connector atomically creates one matching schedule", async () => {
  const teamId = randomUUID();
  const workspaceId = randomUUID();
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Schedule creation",
    slug: workspaceId,
  });
  const created = await connectorRepo.createSourceConnectorRecord({
    teamId,
    workspaceId,
    connectorType: "notion",
    name: "Created with schedule",
    periodicIndexingEnabled: true,
    indexingFrequencyMinutes: 60,
  });
  const [schedule] = await schema.db
    .select()
    .from(schema.taskSchedules)
    .where(eq(schema.taskSchedules.connectorId, created.id));
  assert.equal(schedule?.enabled, true);
  assert.equal(schedule?.intervalMinutes, 60);
  assert.equal(created.nextScheduledAt, schedule?.nextDueAt?.toISOString());
});

test("archiving connector sources hides retained indexed mail", async () => {
  const target = await connector();
  const sourceId = randomUUID();
  await schema.db.insert(schema.sources).values({
    id: sourceId,
    teamId: target.teamId,
    workspaceId: target.workspaceId,
    ingestKind: "connector",
    sourceType: "connector",
    connectorId: target.connectorId,
    title: "Retained mail",
    status: "indexed",
  });
  assert.equal(await syncState.archiveConnectorSources(target), 1);
  const [row] = await schema.db
    .select({ status: schema.sources.status })
    .from(schema.sources)
    .where(eq(schema.sources.id, sourceId));
  assert.equal(row?.status, "archived");
});

test("disabled Gmail indexing stays invisible to retrieval even during an in-flight sync", async () => {
  const teamId = randomUUID();
  const workspaceId = randomUUID();
  const connectorId = randomUUID();
  const sourceId = randomUUID();
  const documentId = randomUUID();
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Gmail retrieval gate",
    slug: workspaceId,
  });
  await schema.db.insert(schema.sourceConnectors).values({
    id: connectorId,
    teamId,
    workspaceId,
    connectorType: "gmail",
    name: "Gmail",
    configJson: { indexingEnabled: true },
  });
  await schema.db.insert(schema.sources).values({
    id: sourceId,
    teamId,
    workspaceId,
    ingestKind: "connector",
    sourceType: "connector",
    connectorId,
    title: "Private mail",
    status: "indexed",
  });
  await schema.db.insert(schema.documents).values({
    id: documentId,
    teamId,
    workspaceId,
    sourceId,
    contentText: "Private mail content",
    status: "ready",
  });
  await schema.db.insert(schema.chunks).values({
    id: randomUUID(),
    teamId,
    workspaceId,
    sourceId,
    documentId,
    chunkNo: 0,
    content: "Private mail content",
  });
  const query = {
    teamId,
    workspaceId,
    documentId,
    sourceId,
    limit: 10,
  };
  assert.equal(
    (await retrievalRepo.listDocumentChunksForDocument(query)).length,
    1,
  );
  await connectorRepo.updateSourceConnectorRecord({
    teamId,
    workspaceId,
    connectorId,
    configJson: { indexingEnabled: false },
  });
  assert.equal(
    (await retrievalRepo.listDocumentChunksForDocument(query)).length,
    0,
  );
});

test("connector sync lock excludes concurrent workers and releases after completion", async () => {
  const connectorId = randomUUID();
  const release = await syncLock.tryAcquireConnectorSyncLock(connectorId);
  assert.ok(release);
  assert.equal(await syncLock.tryAcquireConnectorSyncLock(connectorId), null);
  await release();
  const releaseAgain = await syncLock.tryAcquireConnectorSyncLock(connectorId);
  assert.ok(releaseAgain);
  await releaseAgain();
});

test("reserved user-owned task schedules are never dispatched by the connector scheduler", async () => {
  const target = await connector();
  const scheduleId = randomUUID();
  await schema.db.insert(schema.taskSchedules).values({
    id: scheduleId,
    teamId: target.teamId,
    workspaceId: target.workspaceId,
    taskKind: "agent_task",
    ownerKind: "user",
    ownerUserId: "future-user",
    enabled: true,
    specJson: { kind: "once", at: new Date().toISOString() },
    timezone: "Asia/Singapore",
    nextDueAt: new Date(Date.now() - 60_000),
  });
  await schedules.materializeDueConnectorSchedules({
    now: new Date(),
    limit: 25,
  });
  const rows = await schema.db
    .select()
    .from(schema.scheduleOccurrences)
    .where(eq(schema.scheduleOccurrences.scheduleId, scheduleId));
  assert.equal(rows.length, 0);
});

test("two scheduler ticks materialize and claim one connector occurrence", async () => {
  const target = await connector();
  const schedule = await schedules.putConnectorSchedule({
    ...target,
    enabled: true,
    intervalMinutes: 60,
  });
  await schema.db
    .update(schema.taskSchedules)
    .set({ nextDueAt: new Date(Date.now() - 3 * 60 * 60_000) })
    .where(eq(schema.taskSchedules.id, schedule.id));
  const now = new Date();
  await Promise.all([
    schedules.materializeDueConnectorSchedules({ now, limit: 25 }),
    schedules.materializeDueConnectorSchedules({ now, limit: 25 }),
  ]);
  const rows = await schema.db
    .select()
    .from(schema.scheduleOccurrences)
    .where(eq(schema.scheduleOccurrences.scheduleId, schedule.id));
  assert.equal(rows.length, 1);
  const claimed = await Promise.all([
    schedules.claimDispatchableConnectorOccurrences({ now, limit: 25 }),
    schedules.claimDispatchableConnectorOccurrences({ now, limit: 25 }),
  ]);
  assert.equal(
    claimed.flat().filter((x) => x.schedule.id === schedule.id).length,
    1,
  );
});

test("a late interval coalesces into one pending run and pause retires it", async () => {
  const target = await connector();
  const schedule = await schedules.putConnectorSchedule({
    ...target,
    enabled: true,
    intervalMinutes: 15,
  });
  await schema.db
    .update(schema.taskSchedules)
    .set({ nextDueAt: new Date(Date.now() - 5 * 60 * 60_000) })
    .where(eq(schema.taskSchedules.id, schedule.id));
  const now = new Date();
  await schedules.materializeDueConnectorSchedules({ now, limit: 25 });
  const pending = await schema.db
    .select()
    .from(schema.scheduleOccurrences)
    .where(
      and(
        eq(schema.scheduleOccurrences.scheduleId, schedule.id),
        eq(schema.scheduleOccurrences.status, "pending"),
      ),
    );
  assert.equal(pending.length, 1);
  await schedules.putConnectorSchedule({
    ...target,
    enabled: false,
    requestedPeriodicIndexingEnabled: true,
    intervalMinutes: 15,
  });
  const [retired] = await schema.db
    .select()
    .from(schema.scheduleOccurrences)
    .where(eq(schema.scheduleOccurrences.id, pending[0]!.id));
  assert.equal(retired?.status, "skipped");
  const [source] = await schema.db
    .select()
    .from(schema.sourceConnectors)
    .where(eq(schema.sourceConnectors.id, target.connectorId));
  assert.equal(source?.periodicIndexingEnabled, true);
  assert.equal(source?.nextScheduledAt, null);
});

test("page checkpoints advance only for matching connector scope", async () => {
  const target = await connector();
  await syncState.getOrResetConnectorSyncState({
    connectorId: target.connectorId,
    scopeHash: "scope-a",
  });
  await syncState.commitConnectorSyncPage({
    connectorId: target.connectorId,
    scopeHash: "scope-a",
    expectedGeneration: 0,
    continuation: { page: "2" },
    complete: false,
  });
  let current = await syncState.getOrResetConnectorSyncState({
    connectorId: target.connectorId,
    scopeHash: "scope-a",
  });
  assert.deepEqual(current.pageCursorJson, { page: "2" });
  assert.equal(current.committedCursorJson, null);
  await assert.rejects(
    syncState.commitConnectorSyncPage({
      connectorId: target.connectorId,
      scopeHash: "scope-b",
      expectedGeneration: 1,
      checkpoint: { version: 7 },
      complete: true,
    }),
    /state changed/,
  );
  current = await syncState.getOrResetConnectorSyncState({
    connectorId: target.connectorId,
    scopeHash: "scope-a",
  });
  assert.equal(current.committedCursorJson, null);
  await syncState.commitConnectorSyncPage({
    connectorId: target.connectorId,
    scopeHash: "scope-a",
    expectedGeneration: 1,
    checkpoint: { version: 7 },
    complete: true,
  });
  current = await syncState.getOrResetConnectorSyncState({
    connectorId: target.connectorId,
    scopeHash: "scope-a",
  });
  assert.deepEqual(current.committedCursorJson, { version: 7 });
  assert.equal(current.pageCursorJson, null);
  await assert.rejects(
    syncState.commitConnectorSyncPage({
      connectorId: target.connectorId,
      scopeHash: "scope-a",
      expectedGeneration: 1,
      checkpoint: { version: 6 },
      complete: true,
    }),
    /state changed/,
  );
  await syncState.resetConnectorSyncState({
    connectorId: target.connectorId,
    scopeHash: "scope-a",
  });
  current = await syncState.getOrResetConnectorSyncState({
    connectorId: target.connectorId,
    scopeHash: "scope-a",
  });
  assert.equal(current.committedCursorJson, null);
  assert.equal(current.pageCursorJson, null);
});

test("transient run failure is replayable and reauthorization pauses future sync", async () => {
  const target = await connector();
  const schedule = await schedules.putConnectorSchedule({
    ...target,
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
  const runId = randomUUID();
  await schema.db.insert(schema.connectorSyncRuns).values({
    id: runId,
    ...target,
    status: "failed",
    triggerType: "scheduled",
  });
  await schedules.attachScheduleOccurrenceRun({
    occurrenceId: claimed.occurrence.id,
    runId,
  });
  await schedules.markScheduleOccurrenceQueued(claimed.occurrence.id);
  await schedules.completeScheduleOccurrence({
    runId,
    succeeded: false,
    errorCode: "PROVIDER_429",
  });
  const [retry] = await schema.db
    .select()
    .from(schema.scheduleOccurrences)
    .where(eq(schema.scheduleOccurrences.id, claimed.occurrence.id));
  assert.equal(retry?.status, "pending");
  assert.equal(retry?.syncRunId, null);
  assert.ok(retry?.retryAt);

  await schema.db
    .update(schema.scheduleOccurrences)
    .set({ status: "dispatching", attempts: 3, retryAt: null })
    .where(eq(schema.scheduleOccurrences.id, claimed.occurrence.id));
  const secondRunId = randomUUID();
  await schema.db.insert(schema.connectorSyncRuns).values({
    id: secondRunId,
    ...target,
    status: "failed",
    triggerType: "scheduled",
  });
  await schedules.attachScheduleOccurrenceRun({
    occurrenceId: claimed.occurrence.id,
    runId: secondRunId,
  });
  await schedules.markScheduleOccurrenceQueued(claimed.occurrence.id);
  await schedules.completeScheduleOccurrence({
    runId: secondRunId,
    succeeded: false,
    errorCode: "CONNECTOR_REAUTH_REQUIRED",
  });
  const [paused] = await schema.db
    .select()
    .from(schema.taskSchedules)
    .where(eq(schema.taskSchedules.id, schedule.id));
  assert.equal(paused?.enabled, false);
  assert.equal(paused?.nextDueAt, null);
  const [source] = await schema.db
    .select()
    .from(schema.sourceConnectors)
    .where(eq(schema.sourceConnectors.id, target.connectorId));
  assert.equal(source?.periodicIndexingEnabled, false);
});

test("a lost worker releases its occurrence for replay", async () => {
  const target = await connector();
  const schedule = await schedules.putConnectorSchedule({
    ...target,
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
  const runId = randomUUID();
  await schema.db.insert(schema.connectorSyncRuns).values({
    id: runId,
    ...target,
    triggerType: "scheduled",
    status: "running",
    heartbeatAt: new Date(Date.now() - 20 * 60_000),
  });
  await schedules.attachScheduleOccurrenceRun({
    occurrenceId: claimed.occurrence.id,
    runId,
  });
  await schedules.markScheduleOccurrenceQueued(claimed.occurrence.id);
  const stale = await schedules.listStaleRunningConnectorOccurrences({
    cutoff: new Date(Date.now() - 10 * 60_000),
    limit: 25,
  });
  assert.ok(stale.some((item) => item.run.id === runId));
  await schedules.recoverLostScheduleOccurrence({
    occurrenceId: claimed.occurrence.id,
    runId,
    ...target,
  });
  const [replay] = await schema.db
    .select()
    .from(schema.scheduleOccurrences)
    .where(eq(schema.scheduleOccurrences.id, claimed.occurrence.id));
  const [failedRun] = await schema.db
    .select()
    .from(schema.connectorSyncRuns)
    .where(eq(schema.connectorSyncRuns.id, runId));
  assert.equal(replay?.status, "pending");
  assert.equal(replay?.syncRunId, null);
  assert.ok(replay?.retryAt);
  assert.equal(failedRun?.status, "failed");
  assert.equal(failedRun?.errorCode, "CONNECTOR_WORKER_LOST");
});

test("authoritative reconciliation archives only connector items absent from the completed run", async () => {
  const target = await connector();
  const oldRun = randomUUID();
  const newRun = randomUUID();
  for (const id of [oldRun, newRun]) {
    await schema.db.insert(schema.connectorSyncRuns).values({
      id,
      ...target,
      status: "succeeded",
      triggerType: "manual",
    });
  }
  const oldSource = randomUUID();
  const currentSource = randomUUID();
  await schema.db.insert(schema.sources).values([
    {
      id: oldSource,
      ...target,
      ingestKind: "connector",
      sourceType: "connector",
      title: "Removed file",
      externalId: "removed",
      syncRunId: oldRun,
      status: "indexed",
    },
    {
      id: currentSource,
      ...target,
      ingestKind: "connector",
      sourceType: "connector",
      title: "Current file",
      externalId: "current",
      syncRunId: newRun,
      status: "indexed",
    },
  ]);
  const archived = await syncState.archiveConnectorSourcesNotSeenInRun({
    ...target,
    runId: newRun,
  });
  assert.equal(archived, 1);
  const rows = await schema.db
    .select({ id: schema.sources.id, status: schema.sources.status })
    .from(schema.sources)
    .where(eq(schema.sources.connectorId, target.connectorId));
  assert.equal(rows.find((row) => row.id === oldSource)?.status, "archived");
  assert.equal(rows.find((row) => row.id === currentSource)?.status, "indexed");
});

test("scheduler retries a lost dispatch from the durable occurrence", async () => {
  const target = await connector();
  const schedule = await schedules.putConnectorSchedule({
    ...target,
    enabled: true,
    intervalMinutes: 60,
  });
  await schema.db
    .update(schema.taskSchedules)
    .set({ nextDueAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.taskSchedules.id, schedule.id));
  const dispatch = vi
    .spyOn(connectorRuntime.connectorSyncOrchestrator, "enqueueScheduledRun")
    .mockRejectedValueOnce(new Error("queue unavailable"))
    .mockImplementation(async (input) => {
      const run = await syncRunRepo.createSyncRunRecord({
        ...target,
        triggerType: "scheduled",
        status: "queued",
      });
      await schedules.attachScheduleOccurrenceRun({
        occurrenceId: input.occurrenceId!,
        runId: run.id,
      });
      return { run, jobId: "recovered" };
    });
  await scheduler.scheduleConnectorSyncs();
  const [pending] = await schema.db
    .select()
    .from(schema.scheduleOccurrences)
    .where(eq(schema.scheduleOccurrences.scheduleId, schedule.id));
  assert.equal(pending?.status, "pending");
  assert.ok(pending?.retryAt);
  await schema.db
    .update(schema.scheduleOccurrences)
    .set({ retryAt: new Date(Date.now() - 1_000) })
    .where(eq(schema.scheduleOccurrences.id, pending!.id));
  await scheduler.scheduleConnectorSyncs();
  const [recovered] = await schema.db
    .select()
    .from(schema.scheduleOccurrences)
    .where(eq(schema.scheduleOccurrences.id, pending!.id));
  assert.equal(recovered?.status, "queued");
  assert.equal(dispatch.mock.calls.length, 2);
  dispatch.mockRestore();
});

test("expired provider cursor resets durable progress before the next full scan", async () => {
  const target = await connector();
  let discoveryMode: "expired" | "item-failure" = "expired";
  await schema.db
    .update(schema.sourceConnectors)
    .set({ connectorType: "fake_sched" })
    .where(eq(schema.sourceConnectors.id, target.connectorId));
  const manifest = {
    type: "fake_sched",
    displayName: "Fake schedule source",
    auth: {
      kind: "oauth2" as const,
      authorizationUrl: "https://example.com/auth",
      tokenUrl: "https://example.com/token",
      scopes: [],
    },
    sync: {
      supportsIncremental: true,
      defaultFrequencyMinutes: 60,
      resources: [
        {
          type: "document",
          displayName: "Document",
          supportsDeleteDetection: true,
        },
      ],
    },
    actions: [],
    configSchema: { type: "object" },
  };
  const adapter = {
    getManifest: () => manifest,
    async *discover() {},
    async *discoverPages() {
      if (discoveryMode === "item-failure") {
        yield {
          items: [
            {
              externalId: "bad-item",
              externalUri: "https://example.com/bad-item",
              title: "Bad item",
              mimeType: "text/plain",
              sizeBytes: null,
              externalUpdatedAt: null,
              contentHash: null,
              metadata: {},
            },
          ],
          continuation: { page: "2" },
          complete: false,
        };
        return;
      }
      yield {
        items: [],
        continuation: { page: "2" },
        complete: false,
      };
      throw new ConnectorError(
        409,
        "CONNECTOR_CURSOR_EXPIRED",
        "Provider history expired",
      );
    },
    async extract() {
      throw new ConnectorError(502, "PROVIDER_ITEM_FAILED", "Item unavailable");
    },
  } as unknown as ConnectorAdapter;
  const registry = new connectorRuntime.ConnectorRegistry([adapter]);
  const oauth = {
    getRuntimeToken: async () => "test-token",
  } as unknown as InstanceType<typeof connectorRuntime.ConnectorOAuthService>;
  const orchestrator = new connectorRuntime.ConnectorSyncOrchestrator(
    createCoreBillingRuntime() as ContentBillingPort,
    registry,
    oauth,
    async ({ triggerUserId }) => triggerUserId,
  );
  const run = await syncRunRepo.createSyncRunRecord({
    ...target,
    triggerType: "manual",
    status: "queued",
  });
  await assert.rejects(
    orchestrator.run({ ...target, runId: run.id, userId: "test-user" }),
    /history expired/,
  );
  const [state] = await schema.db
    .select()
    .from(schema.connectorSyncState)
    .where(eq(schema.connectorSyncState.connectorId, target.connectorId));
  assert.equal(state?.pageCursorJson, null);
  assert.equal(state?.committedCursorJson, null);
  const [failed] = await schema.db
    .select()
    .from(schema.connectorSyncRuns)
    .where(eq(schema.connectorSyncRuns.id, run.id));
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.errorCode, "CONNECTOR_CURSOR_EXPIRED");

  const scopeHash = (await import("node:crypto"))
    .createHash("sha256")
    .update(JSON.stringify({ type: "fake_sched", config: {} }))
    .digest("hex");
  const currentState = await syncState.getOrResetConnectorSyncState({
    connectorId: target.connectorId,
    scopeHash,
  });
  await syncState.commitConnectorSyncPage({
    connectorId: target.connectorId,
    scopeHash,
    expectedGeneration: currentState.generation,
    checkpoint: { version: 7 },
    complete: true,
  });
  discoveryMode = "item-failure";
  const failedItemRun = await syncRunRepo.createSyncRunRecord({
    ...target,
    triggerType: "manual",
    status: "queued",
  });
  await assert.rejects(
    orchestrator.run({
      ...target,
      runId: failedItemRun.id,
      userId: "test-user",
    }),
    /page will be replayed/,
  );
  const [afterItemFailure] = await schema.db
    .select()
    .from(schema.connectorSyncState)
    .where(eq(schema.connectorSyncState.connectorId, target.connectorId));
  assert.deepEqual(afterItemFailure?.committedCursorJson, { version: 7 });
  assert.equal(afterItemFailure?.pageCursorJson, null);
});
