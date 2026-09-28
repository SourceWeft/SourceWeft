import { scheduleDueMcpReadmes } from "../../modules/market/readme/readme-fetch";
import { logger } from "../../shared/logger";

/**
 * How often the MCP catalog's due READMEs are queued. At most one batch of
 * `MCP_README_BATCH_SIZE` per run and never a second while one is in flight,
 * so the job spends at most a few hundred GraphQL points a batch however large
 * the catalog. Once the backlog is read, only new versions and the periodic
 * refreshes remain due, and a new server's README follows within minutes of
 * the federation sync that brought it in.
 */
export const MCP_README_SCHEDULE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Queue the next batch of MCP server READMEs to fetch. Only queues: the worker
 * does the GitHub reads, since the scheduler is not given `GITHUB_TOKEN`.
 */
export async function scheduleMcpReadmeFetches(): Promise<void> {
  const result = await scheduleDueMcpReadmes();
  if (result.queued > 0) {
    logger.info("Queued MCP README fetch batch", result);
  }
}
