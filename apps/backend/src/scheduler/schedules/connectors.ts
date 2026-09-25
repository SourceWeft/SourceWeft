import { connectorSyncOrchestrator } from "../../modules/connectors";
import {
  enqueueConnectorSyncJob,
  getConnectorSyncJobState,
} from "../../modules/content/queue";
import { logger } from "../../shared/logger";
import { toConnectorError } from "../../modules/connectors/errors";
import {
  claimDispatchableConnectorOccurrences,
  completeScheduleOccurrence,
  listQueuedConnectorOccurrences,
  listStaleRunningConnectorOccurrences,
  markScheduleOccurrenceQueued,
  markScheduleOccurrenceSkipped,
  materializeDueConnectorSchedules,
  listQuotaBlockedConnectorRecords,
  retryScheduleOccurrence,
  recoverLostScheduleOccurrence,
  pauseConnectorScheduleForAuth,
} from "../../modules/connectors/repository";

const SCHEDULED_CONNECTOR_LIMIT = 25;
/** How long a quota-blocked connector waits between resume checks. */
const QUOTA_RESUME_CHECK_INTERVAL_MS = 10 * 60_000;

/**
 * Restarts connectors paused on ingestion pages once their owner has pages
 * again (top-up, cycle regrant, plan change), including connectors with no
 * schedule of their own.
 */
export async function resumeQuotaBlockedConnectors(now = new Date()) {
  const blocked = await listQuotaBlockedConnectorRecords({
    checkedBefore: new Date(now.getTime() - QUOTA_RESUME_CHECK_INTERVAL_MS),
    limit: SCHEDULED_CONNECTOR_LIMIT,
  });
  for (const connector of blocked) {
    try {
      await connectorSyncOrchestrator.enqueueQuotaResumeRun({
        connector,
        enqueue: enqueueConnectorSyncJob,
      });
    } catch (error) {
      logger.error("Failed to resume quota-blocked connector sync", {
        connectorId: connector.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function scheduleConnectorSyncs() {
  const now = new Date();
  await materializeDueConnectorSchedules({
    now,
    limit: SCHEDULED_CONNECTOR_LIMIT,
  });

  // A DB occurrence is the outbox. Queue entries may be lost independently of
  // the transaction that created them, so replaying the same run ID is safe.
  const queued = await listQueuedConnectorOccurrences(
    SCHEDULED_CONNECTOR_LIMIT * 2,
  );
  for (const { occurrence, schedule, run } of queued) {
    if (!schedule.connectorId) continue;
    try {
      if (
        run.status === "succeeded" ||
        run.status === "failed" ||
        run.status === "skipped" ||
        run.status === "blocked"
      ) {
        await completeScheduleOccurrence({
          runId: run.id,
          succeeded: run.status === "succeeded" && run.failedCount === 0,
          errorCode: run.errorCode,
        });
      } else if (run.status === "queued" && schedule.enabled) {
        await enqueueConnectorSyncJob({
          runId: run.id,
          teamId: schedule.teamId,
          workspaceId: schedule.workspaceId,
          connectorId: schedule.connectorId,
          userId: "system",
        });
      }
    } catch (error) {
      logger.error("Failed to reconcile queued connector sync", {
        occurrenceId: occurrence.id,
        connectorId: schedule.connectorId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const stale = await listStaleRunningConnectorOccurrences({
    cutoff: new Date(now.getTime() - 10 * 60_000),
    limit: SCHEDULED_CONNECTOR_LIMIT,
  });
  for (const { occurrence, schedule, run } of stale) {
    if (!schedule.connectorId) continue;
    try {
      const jobState = await getConnectorSyncJobState({
        connectorId: schedule.connectorId,
        runId: run.id,
      });
      if (!jobState || jobState === "failed" || jobState === "completed") {
        await recoverLostScheduleOccurrence({
          occurrenceId: occurrence.id,
          runId: run.id,
          teamId: schedule.teamId,
          workspaceId: schedule.workspaceId,
          connectorId: schedule.connectorId,
        });
      }
    } catch (error) {
      logger.error("Failed to inspect stale connector sync", {
        occurrenceId: occurrence.id,
        connectorId: schedule.connectorId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const due = await claimDispatchableConnectorOccurrences({
    now,
    limit: SCHEDULED_CONNECTOR_LIMIT,
  });
  for (const { occurrence, schedule } of due) {
    if (!schedule.connectorId) continue;
    try {
      const result = await connectorSyncOrchestrator.enqueueScheduledRun({
        teamId: schedule.teamId,
        workspaceId: schedule.workspaceId,
        connectorId: schedule.connectorId,
        userId: "system",
        occurrenceId: occurrence.id,
        existingRunId: occurrence.syncRunId,
        enqueue: enqueueConnectorSyncJob,
      });
      if (result.skipped) {
        if (result.reason === "connector_already_running") {
          await retryScheduleOccurrence({
            occurrenceId: occurrence.id,
            attempts: occurrence.attempts + 1,
            error: result.reason,
          });
        } else {
          await markScheduleOccurrenceSkipped({
            occurrenceId: occurrence.id,
            reason: result.reason ?? "connector_not_ready",
          });
        }
      } else {
        await markScheduleOccurrenceQueued(occurrence.id);
      }
    } catch (error) {
      const connectorError = toConnectorError(error);
      logger.error("Failed to schedule connector sync", {
        occurrenceId: occurrence.id,
        connectorId: schedule.connectorId,
        message: error instanceof Error ? error.message : String(error),
      });
      if (
        connectorError.code === "CONNECTOR_REAUTH_REQUIRED" ||
        connectorError.code === "CONNECTOR_OAUTH_ACCOUNT_UNAVAILABLE"
      ) {
        await pauseConnectorScheduleForAuth({
          connectorId: schedule.connectorId,
          errorCode: connectorError.code,
        });
        await markScheduleOccurrenceSkipped({
          occurrenceId: occurrence.id,
          reason: connectorError.code,
        });
      } else {
        await retryScheduleOccurrence({
          occurrenceId: occurrence.id,
          attempts: occurrence.attempts + 1,
          error: connectorError.message,
        });
      }
    }
  }

  await resumeQuotaBlockedConnectors(now);
}
