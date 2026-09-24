import { and, asc, eq, inArray, lte } from "drizzle-orm";
import {
  connectorSyncRuns,
  db,
  scheduleOccurrences,
  sourceConnectors,
  taskSchedules,
} from "@sourceweft/db";

export async function attachScheduleOccurrenceRun(input: {
  occurrenceId: string;
  runId: string;
}) {
  await db
    .update(scheduleOccurrences)
    .set({ syncRunId: input.runId, updatedAt: new Date() })
    .where(eq(scheduleOccurrences.id, input.occurrenceId));
}

export async function markScheduleOccurrenceQueued(occurrenceId: string) {
  const now = new Date();
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(scheduleOccurrences)
      .set({ status: "queued", leaseUntil: null, updatedAt: now })
      .where(
        and(
          eq(scheduleOccurrences.id, occurrenceId),
          eq(scheduleOccurrences.status, "dispatching"),
        ),
      )
      .returning({ scheduleId: scheduleOccurrences.scheduleId });
    if (row) {
      await tx
        .update(taskSchedules)
        .set({ lastAttemptAt: now, retryAt: null, updatedAt: now })
        .where(eq(taskSchedules.id, row.scheduleId));
    }
  });
}

export async function markScheduleOccurrenceSkipped(input: {
  occurrenceId: string;
  reason: string;
}) {
  const now = new Date();
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(scheduleOccurrences)
      .set({
        status: "skipped",
        leaseUntil: null,
        lastError: input.reason.slice(0, 500),
        updatedAt: now,
      })
      .where(
        and(
          eq(scheduleOccurrences.id, input.occurrenceId),
          eq(scheduleOccurrences.status, "dispatching"),
        ),
      )
      .returning({ scheduleId: scheduleOccurrences.scheduleId });
    if (row) {
      await tx
        .update(taskSchedules)
        .set({
          lastAttemptAt: now,
          lastErrorCode: input.reason.slice(0, 200),
          updatedAt: now,
        })
        .where(eq(taskSchedules.id, row.scheduleId));
    }
  });
}

export async function listQueuedConnectorOccurrences(limit: number) {
  return db
    .select({
      occurrence: scheduleOccurrences,
      schedule: taskSchedules,
      run: connectorSyncRuns,
    })
    .from(scheduleOccurrences)
    .innerJoin(
      taskSchedules,
      eq(scheduleOccurrences.scheduleId, taskSchedules.id),
    )
    .innerJoin(
      connectorSyncRuns,
      eq(scheduleOccurrences.syncRunId, connectorSyncRuns.id),
    )
    .where(
      and(
        eq(scheduleOccurrences.status, "queued"),
        eq(taskSchedules.taskKind, "connector_sync"),
        inArray(connectorSyncRuns.status, [
          "queued",
          "succeeded",
          "failed",
          "skipped",
        ]),
      ),
    )
    .orderBy(asc(scheduleOccurrences.updatedAt))
    .limit(limit);
}

export async function listStaleRunningConnectorOccurrences(input: {
  cutoff: Date;
  limit: number;
}) {
  return db
    .select({
      occurrence: scheduleOccurrences,
      schedule: taskSchedules,
      run: connectorSyncRuns,
    })
    .from(scheduleOccurrences)
    .innerJoin(
      taskSchedules,
      eq(scheduleOccurrences.scheduleId, taskSchedules.id),
    )
    .innerJoin(
      connectorSyncRuns,
      eq(scheduleOccurrences.syncRunId, connectorSyncRuns.id),
    )
    .where(
      and(
        eq(scheduleOccurrences.status, "queued"),
        eq(taskSchedules.taskKind, "connector_sync"),
        eq(connectorSyncRuns.status, "running"),
        lte(connectorSyncRuns.heartbeatAt, input.cutoff),
      ),
    )
    .orderBy(asc(connectorSyncRuns.heartbeatAt))
    .limit(input.limit);
}

export async function recoverLostScheduleOccurrence(input: {
  occurrenceId: string;
  runId: string;
  teamId: string;
  workspaceId: string;
  connectorId: string;
}) {
  const now = new Date();
  await db.transaction(async (tx) => {
    const [lostRun] = await tx
      .update(connectorSyncRuns)
      .set({
        status: "failed",
        errorCode: "CONNECTOR_WORKER_LOST",
        errorMessage: "Connector worker stopped before completing the run",
        finishedAt: now,
        heartbeatAt: now,
      })
      .where(
        and(
          eq(connectorSyncRuns.id, input.runId),
          eq(connectorSyncRuns.teamId, input.teamId),
          eq(connectorSyncRuns.workspaceId, input.workspaceId),
          eq(connectorSyncRuns.connectorId, input.connectorId),
          eq(connectorSyncRuns.status, "running"),
        ),
      )
      .returning({ id: connectorSyncRuns.id });
    if (!lostRun) return;
    await tx
      .update(scheduleOccurrences)
      .set({
        status: "pending",
        syncRunId: null,
        retryAt: new Date(now.getTime() + 30_000),
        lastError: "worker_lost",
        updatedAt: now,
      })
      .where(
        and(
          eq(scheduleOccurrences.id, input.occurrenceId),
          eq(scheduleOccurrences.syncRunId, input.runId),
          eq(scheduleOccurrences.status, "queued"),
        ),
      );
  });
}

export async function pauseConnectorScheduleForAuth(input: {
  connectorId: string;
  errorCode: string;
}) {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(taskSchedules)
      .set({
        enabled: false,
        nextDueAt: null,
        retryAt: null,
        lastErrorCode: input.errorCode,
        updatedAt: now,
      })
      .where(eq(taskSchedules.connectorId, input.connectorId));
    await tx
      .update(sourceConnectors)
      .set({
        periodicIndexingEnabled: false,
        nextScheduledAt: null,
        status: "error",
        lastError: "Reconnect the provider account to resume scheduled sync",
        updatedAt: now,
      })
      .where(eq(sourceConnectors.id, input.connectorId));
  });
}

export async function retryScheduleOccurrence(input: {
  occurrenceId: string;
  error: string;
  attempts: number;
}) {
  const delayMs = Math.min(
    60 * 60_000,
    30_000 * 2 ** Math.min(input.attempts, 7),
  );
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(scheduleOccurrences)
      .set({
        status: input.attempts >= 5 ? "failed" : "pending",
        retryAt: input.attempts >= 5 ? null : new Date(Date.now() + delayMs),
        leaseUntil: null,
        lastError: input.error.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scheduleOccurrences.id, input.occurrenceId),
          eq(scheduleOccurrences.status, "dispatching"),
        ),
      )
      .returning();
    if (row?.syncRunId && input.attempts >= 5) {
      await tx
        .update(connectorSyncRuns)
        .set({
          status: "failed",
          errorCode: "CONNECTOR_DISPATCH_FAILED",
          errorMessage: input.error.slice(0, 500),
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(connectorSyncRuns.id, row.syncRunId),
            eq(connectorSyncRuns.status, "queued"),
          ),
        );
    }
    if (row) {
      await tx
        .update(taskSchedules)
        .set({
          lastAttemptAt: new Date(),
          retryAt: row.retryAt,
          lastErrorCode: "CONNECTOR_DISPATCH_FAILED",
          updatedAt: new Date(),
        })
        .where(eq(taskSchedules.id, row.scheduleId));
    }
  });
}

export async function completeScheduleOccurrence(input: {
  runId: string;
  succeeded: boolean;
  errorCode?: string | null;
}) {
  const now = new Date();
  await db.transaction(async (tx) => {
    const [occurrence] = await tx
      .select({ occurrence: scheduleOccurrences, schedule: taskSchedules })
      .from(scheduleOccurrences)
      .innerJoin(
        taskSchedules,
        eq(scheduleOccurrences.scheduleId, taskSchedules.id),
      )
      .where(eq(scheduleOccurrences.syncRunId, input.runId))
      .limit(1);
    if (!occurrence) return;
    const requiresReauth =
      input.errorCode === "CONNECTOR_REAUTH_REQUIRED" ||
      input.errorCode === "CONNECTOR_OAUTH_ACCOUNT_UNAVAILABLE";
    const retry =
      !input.succeeded && !requiresReauth && occurrence.occurrence.attempts < 3;
    const retryAt = retry
      ? new Date(now.getTime() + 30_000 * 2 ** occurrence.occurrence.attempts)
      : null;
    await tx
      .update(scheduleOccurrences)
      .set({
        status: input.succeeded ? "succeeded" : retry ? "pending" : "failed",
        syncRunId: retry ? null : occurrence.occurrence.syncRunId,
        retryAt,
        leaseUntil: null,
        lastError: input.errorCode ?? null,
        updatedAt: now,
      })
      .where(eq(scheduleOccurrences.id, occurrence.occurrence.id));
    await tx
      .update(taskSchedules)
      .set({
        lastAttemptAt: now,
        ...(input.succeeded ? { lastSuccessAt: now } : {}),
        lastErrorCode: input.errorCode ?? null,
        retryAt,
        ...(requiresReauth ? { enabled: false, nextDueAt: null } : {}),
        updatedAt: now,
      })
      .where(eq(taskSchedules.id, occurrence.schedule.id));
    if (requiresReauth && occurrence.schedule.connectorId) {
      await tx
        .update(sourceConnectors)
        .set({
          periodicIndexingEnabled: false,
          nextScheduledAt: null,
          updatedAt: now,
        })
        .where(eq(sourceConnectors.id, occurrence.schedule.connectorId));
    }
  });
}

export async function skipScheduleOccurrenceByRunId(runId: string) {
  await db
    .update(scheduleOccurrences)
    .set({
      status: "skipped",
      retryAt: null,
      leaseUntil: null,
      lastError: "schedule_paused",
      updatedAt: new Date(),
    })
    .where(eq(scheduleOccurrences.syncRunId, runId));
}
