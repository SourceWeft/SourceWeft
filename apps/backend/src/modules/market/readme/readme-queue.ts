import { logger } from "../../../shared/logger";
import {
  enqueueWithAudit,
  jobsQueue,
  jobsRedisClient,
} from "../../../shared/queue";

/**
 * The README fetch job (`mcp-readme-fetch`) on the primary queue. The
 * scheduler only queues it — `GITHUB_TOKEN` is given to the api and worker
 * services, not to the scheduler — and the worker reads GitHub
 * (`worker/processors/mcp-readme-fetch.ts`).
 *
 * One job is one batch of versions, read in a few concurrent GraphQL queries
 * at a time, so a batch holds one worker slot however large it is.
 */

export const MCP_README_FETCH_JOB = "mcp-readme-fetch";

/**
 * Versions queued per scheduled batch. Twenty GitHub directories cost one
 * GraphQL point and a few seconds, so a full batch is about 250 points and a
 * few minutes of reading: the catalog's backfill takes well under an hour,
 * and later batches are only the new and the due-for-refresh. A spent rate
 * limit defers the rest of the batch rather than failing it.
 */
export const MCP_README_BATCH_SIZE = 5000;

export type McpReadmeFetchJobPayload = {
  versionIds: string[];
  reason: "scheduled" | "admin";
};

/**
 * The scheduled batch's id. One at a time: while a batch is queued or
 * running, the next tick queues nothing, so batches never pile up behind a
 * stopped worker.
 */
export const MCP_README_SCHEDULED_JOB_ID = `${MCP_README_FETCH_JOB}_scheduled`;

/** An admin refetch's id: asking twice before it runs is one job. */
export function mcpReadmeAdminJobId(versionId: string): string {
  return `${MCP_README_FETCH_JOB}_admin_${versionId}`;
}

export async function enqueueMcpReadmeFetch(
  payload: McpReadmeFetchJobPayload,
  jobId: string,
) {
  return enqueueWithAudit(MCP_README_FETCH_JOB, payload, {
    jobId,
    // The next tick is the retry: a failed batch leaves its versions due.
    attempts: 1,
    // Gone once done either way, so the id is free for the next batch.
    removeOnComplete: true,
    removeOnFail: true,
  });
}

/** Whether a job with this id is queued, delayed or running. */
export async function mcpReadmeJobExists(jobId: string): Promise<boolean> {
  return Boolean(await jobsQueue.getJob(jobId));
}

// ---------------------------------------------------------------------------
// Last batch, for the admin status
// ---------------------------------------------------------------------------

const LAST_BATCH_KEY = "sourceweft:mcp-readme-fetch:last-batch";
const LAST_BATCH_TTL_SECONDS = 30 * 24 * 60 * 60;

export type McpReadmeBatchSummary = {
  reason: McpReadmeFetchJobPayload["reason"];
  startedAt: string;
  finishedAt: string;
  /** Versions in the batch. */
  requested: number;
  /** Versions read (or found unsupported) and written. */
  processed: number;
  /** Versions no longer due, or no longer published and public. */
  skipped: number;
  /** Versions pushed back to `rateLimitedUntil` without a request. */
  deferred: number;
  /** Outcomes by fetch status. */
  outcomes: Record<string, number>;
  /**
   * Whether the worker has `GITHUB_TOKEN`. Without it nothing is read: GitHub's
   * GraphQL API has no anonymous access.
   */
  tokenPresent: boolean;
  rateLimitedUntil: string | null;
  /** Why the batch stopped before its end, if it did. */
  stoppedBy: "no_token" | "unauthorized" | "rate_limited" | null;
  /** GraphQL points the batch cost, and what GitHub said was left after it. */
  points: number;
  pointsRemaining: number | null;
};

/** Keeps the worker's last batch where the api can show it to admins. */
export async function recordMcpReadmeBatch(
  summary: McpReadmeBatchSummary,
): Promise<void> {
  try {
    const redis = await jobsRedisClient();
    await redis.set(
      LAST_BATCH_KEY,
      JSON.stringify(summary),
      "EX",
      LAST_BATCH_TTL_SECONDS,
    );
  } catch (error) {
    // The batch's own result is already in the database and the job audit;
    // only the admin summary is missing.
    logger.warn("Could not record the MCP README batch summary", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function readLastMcpReadmeBatch(): Promise<McpReadmeBatchSummary | null> {
  const redis = await jobsRedisClient();
  const value = await redis.get(LAST_BATCH_KEY);
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as McpReadmeBatchSummary;
  } catch {
    return null;
  }
}
