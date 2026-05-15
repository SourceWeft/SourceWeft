import { connectorSyncOrchestrator } from "../../modules/connectors";
import { enqueueConnectorSyncJob } from "../../modules/content/queue";
import { logger } from "../../shared/logger";
import { listDueScheduledConnectorRecords } from "../../modules/connectors/repository";

const SCHEDULED_CONNECTOR_LIMIT = 25;

export async function scheduleConnectorSyncs() {
  const connectors = await listDueScheduledConnectorRecords({
    now: new Date(),
    limit: SCHEDULED_CONNECTOR_LIMIT,
  });

  for (const connector of connectors) {
    try {
      const run = await connectorSyncOrchestrator.createScheduledRun({
        teamId: connector.teamId,
        workspaceId: connector.workspaceId,
        connectorId: connector.id,
      });
      await enqueueConnectorSyncJob({
        runId: run.id,
        teamId: connector.teamId,
        workspaceId: connector.workspaceId,
        connectorId: connector.id,
        userId: connector.createdBy ?? "system",
      });
    } catch (error) {
      logger.error("Failed to schedule connector sync", {
        connectorId: connector.id,
        connectorType: connector.connectorType,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
