import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  connectorSyncRuns,
  db,
  scheduleOccurrences,
  sourceConnectors,
  taskSchedules,
} from "@sourceweft/db";
import {
  claimDispatchableOccurrences,
  intervalSlot,
  materializeDueSchedules,
  stableJitterMs,
} from "../../schedules";

// Callers (and the connector row writer) keep importing the jitter from here.
export { stableJitterMs };

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
  return materializeDueSchedules({
    taskKind: "connector_sync",
    now: input.now,
    limit: input.limit,
    computeSlot: (schedule, now) =>
      schedule.nextDueAt && schedule.connectorId && schedule.intervalMinutes
        ? intervalSlot(schedule.nextDueAt, schedule.intervalMinutes, now)
        : null,
    // Compatibility projection for existing connector API/UI clients.
    onMaterialized: async (tx, schedule, slot) => {
      await tx
        .update(sourceConnectors)
        .set({ nextScheduledAt: slot.nextDueAt, updatedAt: input.now })
        .where(eq(sourceConnectors.id, schedule.connectorId!));
    },
  });
}

export async function claimDispatchableConnectorOccurrences(input: {
  now: Date;
  limit: number;
}) {
  return claimDispatchableOccurrences({
    taskKind: "connector_sync",
    now: input.now,
    limit: input.limit,
    // One sync per connector at a time; the occurrence's own run is not a rival.
    isTargetBusy: async (tx, { occurrence, schedule }) => {
      if (!schedule.connectorId) return true;
      const [active] = await tx
        .select({ id: connectorSyncRuns.id })
        .from(connectorSyncRuns)
        .where(
          and(
            eq(connectorSyncRuns.connectorId, schedule.connectorId),
            inArray(connectorSyncRuns.status, ["queued", "running"]),
          ),
        )
        .limit(1);
      return Boolean(active && active.id !== occurrence.syncRunId);
    },
  });
}
