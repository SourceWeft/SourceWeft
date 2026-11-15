import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

let schema: typeof import("@sourceweft/db");
let repo: typeof import("./repository");
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("schedule_engine");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repo = await import("./repository");
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

async function dueSchedule(now: Date) {
  const teamId = randomUUID();
  const workspaceId = randomUUID();
  const connectorId = randomUUID();
  const scheduleId = randomUUID();
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Engine test",
    slug: workspaceId,
  });
  await schema.db.insert(schema.sourceConnectors).values({
    id: connectorId,
    teamId,
    workspaceId,
    connectorType: "notion",
    name: connectorId,
  });
  await schema.db.insert(schema.taskSchedules).values({
    id: scheduleId,
    teamId,
    workspaceId,
    taskKind: "connector_sync",
    ownerKind: "workspace",
    connectorId,
    enabled: true,
    intervalMinutes: 60,
    nextDueAt: new Date(now.getTime() - 5 * 60_000),
  });
  return { scheduleId };
}

/** Slot policy that only ever touches the schedule under test. */
function onlySlotFor(scheduleId: string, now: Date) {
  return (schedule: { id: string; nextDueAt: Date | null }) =>
    schedule.id === scheduleId
      ? {
          scheduledFor: schedule.nextDueAt!,
          nextDueAt: new Date(now.getTime() + 60 * 60_000),
        }
      : null;
}

async function occurrenceRow(id: string) {
  const [row] = await schema.db
    .select()
    .from(schema.scheduleOccurrences)
    .where(eq(schema.scheduleOccurrences.id, id));
  return row!;
}

test("materialize runs the slot policy and the in-transaction hook once per due schedule", async () => {
  const now = new Date();
  const { scheduleId } = await dueSchedule(now);
  const seen: string[] = [];
  const count = await repo.materializeDueSchedules({
    taskKind: "connector_sync",
    now,
    limit: 100,
    computeSlot: onlySlotFor(scheduleId, now),
    onMaterialized: async (_tx, schedule) => {
      seen.push(schedule.id);
    },
  });
  assert.ok(count >= 1);
  assert.deepEqual(seen, [scheduleId]);
  const rows = await schema.db
    .select()
    .from(schema.scheduleOccurrences)
    .where(eq(schema.scheduleOccurrences.scheduleId, scheduleId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "pending");
});

test("claim leases an occurrence, honours the busy filter, and skips an active lease", async () => {
  const now = new Date();
  const { scheduleId } = await dueSchedule(now);
  await repo.materializeDueSchedules({
    taskKind: "connector_sync",
    now,
    limit: 100,
    computeSlot: onlySlotFor(scheduleId, now),
  });
  const busy = await repo.claimDispatchableOccurrences({
    taskKind: "connector_sync",
    now,
    limit: 100,
    isTargetBusy: async (_tx, c) => c.schedule.id === scheduleId,
  });
  assert.equal(busy.filter((c) => c.schedule.id === scheduleId).length, 0);
  const first = await repo.claimDispatchableOccurrences({
    taskKind: "connector_sync",
    now,
    limit: 100,
    isTargetBusy: async () => false,
  });
  const mine = first.filter((c) => c.schedule.id === scheduleId);
  assert.equal(mine.length, 1);
  assert.equal(
    (await occurrenceRow(mine[0]!.occurrence.id)).status,
    "dispatching",
  );
  const second = await repo.claimDispatchableOccurrences({
    taskKind: "connector_sync",
    now,
    limit: 100,
    isTargetBusy: async () => false,
  });
  assert.equal(second.filter((c) => c.schedule.id === scheduleId).length, 0);
});

test("retry backs off, then fails for good at the attempt cap and runs the final-failure hook", async () => {
  const now = new Date();
  const { scheduleId } = await dueSchedule(now);
  await repo.materializeDueSchedules({
    taskKind: "connector_sync",
    now,
    limit: 100,
    computeSlot: onlySlotFor(scheduleId, now),
  });
  const claim = async () =>
    (
      await repo.claimDispatchableOccurrences({
        taskKind: "connector_sync",
        now: new Date(Date.now() + 365 * 86_400_000),
        limit: 100,
        isTargetBusy: async () => false,
      })
    ).find((c) => c.schedule.id === scheduleId)!;
  let claimed = await claim();
  const onFinalFailure = vi.fn();
  await repo.retryOccurrence({
    occurrenceId: claimed.occurrence.id,
    attempts: 1,
    error: "temporary",
    errorCode: "TEST_DISPATCH_FAILED",
    onFinalFailure,
  });
  let row = await occurrenceRow(claimed.occurrence.id);
  assert.equal(row.status, "pending");
  assert.ok(row.retryAt);
  assert.equal(onFinalFailure.mock.calls.length, 0);

  claimed = await claim();
  await repo.retryOccurrence({
    occurrenceId: claimed.occurrence.id,
    attempts: 5,
    error: "permanent",
    errorCode: "TEST_DISPATCH_FAILED",
    onFinalFailure,
  });
  row = await occurrenceRow(claimed.occurrence.id);
  assert.equal(row.status, "failed");
  assert.equal(row.retryAt, null);
  assert.equal(onFinalFailure.mock.calls.length, 1);
  const [schedule] = await schema.db
    .select()
    .from(schema.taskSchedules)
    .where(eq(schema.taskSchedules.id, scheduleId));
  assert.equal(schedule!.lastErrorCode, "TEST_DISPATCH_FAILED");
});

test("queued and skipped transitions only apply to a dispatching occurrence", async () => {
  const now = new Date();
  const { scheduleId } = await dueSchedule(now);
  await repo.materializeDueSchedules({
    taskKind: "connector_sync",
    now,
    limit: 100,
    computeSlot: onlySlotFor(scheduleId, now),
  });
  const [pending] = await schema.db
    .select()
    .from(schema.scheduleOccurrences)
    .where(eq(schema.scheduleOccurrences.scheduleId, scheduleId));
  await repo.markOccurrenceQueued(pending!.id);
  assert.equal((await occurrenceRow(pending!.id)).status, "pending");
  await repo.markOccurrenceSkipped({ occurrenceId: pending!.id, reason: "x" });
  assert.equal((await occurrenceRow(pending!.id)).status, "pending");
});
