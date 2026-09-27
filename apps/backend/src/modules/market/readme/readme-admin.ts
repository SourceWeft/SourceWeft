import { logger } from "../../../shared/logger";
import {
  countMcpReadmes,
  resetMcpReadme,
  type McpReadmeStatusCounts,
} from "./readme-repository";
import {
  enqueueMcpReadmeFetch,
  mcpReadmeAdminJobId,
  readLastMcpReadmeBatch,
  type McpReadmeBatchSummary,
} from "./readme-queue";

/** A market admin's view of README fetching (`requireMarketAdmin`-guarded). */

export type McpReadmeRefetchResult = {
  identifier: string;
  version: string;
  status: "pending";
  /**
   * Whether a fetch job was queued now. False when the queue could not be
   * reached; the version is due all the same, so the next scheduled batch
   * fetches it.
   */
  queued: boolean;
};

export type McpReadmeAdminDeps = {
  reset: typeof resetMcpReadme;
  enqueue: typeof enqueueMcpReadmeFetch;
};

const defaultDeps: McpReadmeAdminDeps = {
  reset: resetMcpReadme,
  enqueue: enqueueMcpReadmeFetch,
};

/**
 * Fetch one server's README again: its latest version goes back to
 * `pending`, due now with no attempts counted, and a fetch job is queued for
 * it. Null when no published, public server has this identifier.
 */
export async function requestMcpReadmeRefetch(
  identifier: string,
  deps: McpReadmeAdminDeps = defaultDeps,
): Promise<McpReadmeRefetchResult | null> {
  const reset = await deps.reset({ identifier });
  if (!reset) {
    return null;
  }
  let queued = true;
  try {
    await deps.enqueue(
      { versionIds: [reset.versionId], reason: "admin" },
      mcpReadmeAdminJobId(reset.versionId),
    );
  } catch (error) {
    queued = false;
    logger.warn(
      "Could not queue an MCP README refetch; left due for the next batch",
      {
        identifier,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
  logger.info("MCP README refetch requested", {
    identifier,
    version: reset.version,
    queued,
  });
  return { identifier, version: reset.version, status: "pending", queued };
}

export type McpReadmeAdminStatus = McpReadmeStatusCounts & {
  /**
   * The worker's last batch, including whether its GitHub reads carried
   * `GITHUB_TOKEN`; null before the first batch (or once it is a month old).
   */
  lastBatch: McpReadmeBatchSummary | null;
};

export async function readMcpReadmeAdminStatus(): Promise<McpReadmeAdminStatus> {
  const [counts, lastBatch] = await Promise.all([
    countMcpReadmes(),
    readLastMcpReadmeBatch(),
  ]);
  return { ...counts, lastBatch };
}
