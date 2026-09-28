import { scheduleDueMcpReadmes } from "../../modules/market/readme/readme-fetch";
import { logger } from "../../shared/logger";

/**
 * How often the MCP catalog's due READMEs are queued. At most one batch of
 * `MCP_README_BATCH_SIZE` per run and never a second while one is in flight,
 * so GitHub sees at most a few thousand README reads an hour from this job
 * however large the catalog; once the backlog is read, only the weekly
 * revalidations (mostly free 304s) and new versions remain due.
 */
export const MCP_README_SCHEDULE_INTERVAL_MS = 10 * 60 * 1000;

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
