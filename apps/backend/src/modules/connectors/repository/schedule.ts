import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import {
  connectorSyncRuns,
  db,
  scheduleOccurrences,
  sourceConnectors,
  taskSchedules,
} from "@sourceweft/db";

const DISPATCH_LEASE_MS = 5 * 60_000;

export function stableJitterMs(connectorId: string, intervalMinutes: number) {
  const maxMs = Math.min(5 * 60_000, intervalMinutes * 60_000 * 0.1);
  if (maxMs < 1) return 0;
  return (
    createHash("sha256").update(connectorId).digest().readUInt32BE(0) %
    Math.floor(maxMs)
  );
}

function nextSlot(due: Date, intervalMinutes: number, now: Date) {
  const intervalMs = intervalMinutes * 60_000;
  const steps = Math.max(
    0,
    Math.floor((now.getTime() - due.getTime()) / intervalMs),
  );
  const scheduledFor = new Date(due.getTime() + steps * intervalMs);
  return {
    scheduledFor,
    nextDueAt: new Date(scheduledFor.getTime() + intervalMs),
  };
}

export async function putConnectorSchedule(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  enabled: boolean;
  requestedPeriodicIndexingEnabled?: boolean;
  intervalMinutes: number;
}) {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(taskSchedules)
      .where(eq(taskSchedules.connectorId, input.connectorId))
      .for("update");
    const changed =
      !current ||
      current.enabled !== input.enabled ||
      current.intervalMinutes !== input.intervalMinutes;
    const nextDueAt = changed
      ? input.enabled
        ? new Date(
            now.getTime() +
              input.intervalMinutes * 60_000 +
              stableJitterMs(input.connectorId, input.intervalMinutes),
          )
        : null
      : current.nextDueAt;
    if (current) {
      if (changed) {
        await tx
          .update(scheduleOccurrences)
          .set({
            status: "skipped",
            lastError: "schedule_changed",
            retryAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(scheduleOccurrences.scheduleId, current.id),
              eq(scheduleOccurrences.status, "pending"),
            ),
          );
      }
      const [row] = await tx
        .update(taskSchedules)
        .set({
          enabled: input.enabled,
          intervalMinutes: input.intervalMinutes,
          specJson: { kind: "interval", minutes: input.intervalMinutes },
          timezone: "UTC",
          nextDueAt,
          retryAt: changed ? null : current.retryAt,
          version: changed ? current.version + 1 : current.version,
          updatedAt: now,
        })
        .where(eq(taskSchedules.id, current.id))
        .returning();
      await tx
        .update(sourceConnectors)
        .set({
          periodicIndexingEnabled:
            input.requestedPeriodicIndexingEnabled ?? input.enabled,
          indexingFrequencyMinutes:
            (input.requestedPeriodicIndexingEnabled ?? input.enabled)
              ? input.intervalMinutes
              : null,
          nextScheduledAt: nextDueAt,
        })
        .where(eq(sourceConnectors.id, input.connectorId));
      return row!;
    }
    const [row] = await tx
      .insert(taskSchedules)
      .values({
        id: randomUUID(),
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        taskKind: "connector_sync",
        ownerKind: "workspace",
        connectorId: input.connectorId,
        enabled: input.enabled,
        intervalMinutes: input.intervalMinutes,
        specJson: { kind: "interval", minutes: input.intervalMinutes },
        timezone: "UTC",
        nextDueAt,
      })
      .returning();
    await tx
      .update(sourceConnectors)
      .set({
        periodicIndexingEnabled:
          input.requestedPeriodicIndexingEnabled ?? input.enabled,
        indexingFrequencyMinutes:
          (input.requestedPeriodicIndexingEnabled ?? input.enabled)
            ? input.intervalMinutes
            : null,
        nextScheduledAt: nextDueAt,
      })
      .where(eq(sourceConnectors.id, input.connectorId));
    return row!;
  });
}

export async function isConnectorScheduleEnabled(connectorId: string) {
  const [row] = await db
    .select({ enabled: taskSchedules.enabled })
    .from(taskSchedules)
    .where(eq(taskSchedules.connectorId, connectorId))
    .limit(1);
  return row?.enabled === true;
}

function scheduleStatus(row: typeof taskSchedules.$inferSelect) {
  return {
    enabled: row.enabled,
    nextDueAt: row.nextDueAt?.toISOString() ?? null,
    retryAt: row.retryAt?.toISOString() ?? null,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode,
  };
}

export async function getConnectorScheduleStatus(connectorId: string) {
  const [row] = await db
    .select()
    .from(taskSchedules)
    .where(eq(taskSchedules.connectorId, connectorId))
    .limit(1);
  return row ? scheduleStatus(row) : null;
}

export async function listConnectorScheduleStatuses(input: {
  teamId: string;
  workspaceId: string;
}) {
  const rows = await db
    .select()
    .from(taskSchedules)
    .where(
      and(
        eq(taskSchedules.teamId, input.teamId),
        eq(taskSchedules.workspaceId, input.workspaceId),
        eq(taskSchedules.taskKind, "connector_sync"),
      ),
    );
  return new Map(
    rows
      .filter((row) => row.connectorId)
      .map((row) => [row.connectorId!, scheduleStatus(row)]),
  );
}

/** Materialize one newest due slot, coalescing long outages and long runs. */
export async function materializeDueConnectorSchedules(input: {
  now: Date;
  limit: number;
}) {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(taskSchedules)
      .where(
        and(
          eq(taskSchedules.enabled, true),
          eq(taskSchedules.taskKind, "connector_sync"),
          lte(taskSchedules.nextDueAt, input.now),
        ),
      )
      .orderBy(asc(taskSchedules.nextDueAt))
      .limit(input.limit)
      .for("update", { skipLocked: true });
    for (const schedule of due) {
      if (
        !schedule.nextDueAt ||
        !schedule.connectorId ||
        !schedule.intervalMinutes
      )
        continue;
      const slot = nextSlot(
        schedule.nextDueAt,
        schedule.intervalMinutes,
        input.now,
      );
      const [pending] = await tx
        .select()
        .from(scheduleOccurrences)
        .where(
          and(
            eq(scheduleOccurrences.scheduleId, schedule.id),
            eq(scheduleOccurrences.status, "pending"),
          ),
        )
        .limit(1)
        .for("update");
      if (pending) {
        await tx
          .update(scheduleOccurrences)
          .set({ scheduledFor: slot.scheduledFor, updatedAt: input.now })
          .where(eq(scheduleOccurrences.id, pending.id));
      } else {
        await tx
          .insert(scheduleOccurrences)
          .values({
            id: randomUUID(),
            scheduleId: schedule.id,
            scheduledFor: slot.scheduledFor,
          })
          .onConflictDoNothing();
      }
      await tx
        .update(taskSchedules)
        .set({ nextDueAt: slot.nextDueAt, updatedAt: input.now })
        .where(eq(taskSchedules.id, schedule.id));
      // Compatibility projection for existing connector API/UI clients.
      await tx
        .update(sourceConnectors)
        .set({ nextScheduledAt: slot.nextDueAt, updatedAt: input.now })
        .where(eq(sourceConnectors.id, schedule.connectorId));
    }
    return due.length;
  });
}

export async function claimDispatchableConnectorOccurrences(input: {
  now: Date;
  limit: number;
}) {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ occurrence: scheduleOccurrences, schedule: taskSchedules })
      .from(scheduleOccurrences)
      .innerJoin(
        taskSchedules,
        eq(scheduleOccurrences.scheduleId, taskSchedules.id),
      )
      .where(
        and(
          eq(taskSchedules.enabled, true),
          eq(taskSchedules.taskKind, "connector_sync"),
          or(
            and(
              eq(scheduleOccurrences.status, "pending"),
              or(
                isNull(scheduleOccurrences.retryAt),
                lte(scheduleOccurrences.retryAt, input.now),
              ),
            ),
            and(
              eq(scheduleOccurrences.status, "dispatching"),
              lte(scheduleOccurrences.leaseUntil, input.now),
            ),
          ),
        ),
      )
      .orderBy(asc(scheduleOccurrences.scheduledFor))
      .limit(input.limit)
      .for("update", { skipLocked: true });
    const claimed: typeof candidates = [];
    for (const candidate of candidates) {
      if (!candidate.schedule.connectorId) continue;
      const [active] = await tx
        .select({ id: connectorSyncRuns.id })
        .from(connectorSyncRuns)
        .where(
          and(
            eq(connectorSyncRuns.connectorId, candidate.schedule.connectorId),
            inArray(connectorSyncRuns.status, ["queued", "running"]),
          ),
        )
        .limit(1);
      if (active && active.id !== candidate.occurrence.syncRunId) continue;
      await tx
        .update(scheduleOccurrences)
        .set({
          status: "dispatching",
          leaseUntil: new Date(input.now.getTime() + DISPATCH_LEASE_MS),
          attempts: candidate.occurrence.attempts + 1,
          updatedAt: input.now,
        })
        .where(eq(scheduleOccurrences.id, candidate.occurrence.id));
      claimed.push(candidate);
    }
    return claimed;
  });
}
