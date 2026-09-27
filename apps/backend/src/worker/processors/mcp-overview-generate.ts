import type { Job } from "bullmq";
import { resolveOverviewModelConfigurationKey } from "../../modules/catalog-overview/model";
import {
  generateMcpOverview,
  type GenerateMcpOverviewResult,
} from "../../modules/market/overview/generate";
import { mcpOverviewJobs } from "../../modules/market/overview/queue";

/**
 * One MCP server version's AI overview, through the catalog overview engine's
 * job handling. A failure is thrown for BullMQ to retry with backoff; after
 * the last attempt the request is failed, and the scheduler leaves it until
 * the version's README is read again (see `modules/market/overview`).
 */
export async function processMcpOverviewGenerateJob(
  job: Job<Record<string, unknown>>,
): Promise<GenerateMcpOverviewResult> {
  return mcpOverviewJobs.process(
    job,
    async ({ versionId, requestId, force, scopeId }) =>
      generateMcpOverview({
        versionId,
        requestId,
        force,
        scopeId,
        modelConfigurationKey:
          (await resolveOverviewModelConfigurationKey()) ?? undefined,
      }),
  );
}
