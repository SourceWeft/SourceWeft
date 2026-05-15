import type { Job } from "bullmq";
import { connectorSyncOrchestrator } from "../../modules/connectors";
import type { ConnectorSyncJobPayload } from "../../modules/content/queue";

export async function processConnectorSyncJob(
  job: Job<Record<string, unknown>>,
) {
  const payload = job.data as ConnectorSyncJobPayload;
  return connectorSyncOrchestrator.run(payload);
}
