import { logger } from "../../../shared/logger";
import {
  enqueueWithAudit,
  jobsQueue,
  jobsRedisClient,
} from "../../../shared/queue";

/**
 * The stdio validation job (`mcp-stdio-validate`) on the primary queue
 * (Issue #367, W1b). The scheduler only queues it; the worker starts the
 * packages in the sandbox runtime (`worker/processors/mcp-stdio-validate.ts`).
 *
 * One job is one batch of versions, started {@link MCP_STDIO_CONCURRENCY} at
 * a time, so a batch holds one worker slot however large it is.
 */

export const MCP_STDIO_VALIDATE_JOB = "mcp-stdio-validate";

/**
 * Versions per scheduled batch, and sandboxes running at once within it. A
 * validation is a sandbox create, an install and a start: one to two
 * minutes. Six per batch two at a time is three rounds, well inside the
 * schedule's interval (`scheduler/schedules/mcp-stdio-validation.ts`), and
 * about 550 versions a day: the catalog's ~1,500 packages take the first
 * pass in about three days, deliberately — this is third-party code in a
 * paid sandbox, not a GraphQL query — and after that only new versions and
 * the 30-day refresh are due.
 */
export const MCP_STDIO_BATCH_SIZE = 6;
export const MCP_STDIO_CONCURRENCY = 2;

export type McpStdioValidateJobPayload = {
  versionIds: string[];
  reason: "scheduled" | "admin";
};

/** The scheduled batch's id: one in flight at a time, never piling up. */
export const MCP_STDIO_SCHEDULED_JOB_ID = `${MCP_STDIO_VALIDATE_JOB}_scheduled`;

export async function enqueueMcpStdioValidate(
  payload: McpStdioValidateJobPayload,
  jobId: string,
) {
  return enqueueWithAudit(MCP_STDIO_VALIDATE_JOB, payload, {
    jobId,
    // The next tick is the retry: a failed batch leaves its versions due
    // once their claim lapses.
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  });
}

/** Whether a job with this id is queued, delayed or running. */
export async function mcpStdioJobExists(jobId: string): Promise<boolean> {
  return Boolean(await jobsQueue.getJob(jobId));
}

// ---------------------------------------------------------------------------
// Last batch, kept for operators
// ---------------------------------------------------------------------------

const LAST_BATCH_KEY = "sourceweft:mcp-stdio-validate:last-batch";
const LAST_BATCH_TTL_SECONDS = 30 * 24 * 60 * 60;

export type McpStdioBatchSummary = {
  reason: McpStdioValidateJobPayload["reason"];
  startedAt: string;
  finishedAt: string;
  /** Versions in the batch. */
  requested: number;
  /** Versions claimed (still due, published and public). */
  claimed: number;
  /** Versions written: validated, failed or unsupported. */
  processed: number;
  /** Outcomes: `validated`, or the failure reason. */
  outcomes: Record<string, number>;
  /**
   * Versions the sandbox could not be run for (a create or transfer failed,
   * the driver wrote no result). Nothing is written; they are due again
   * once their claim lapses.
   */
  errors: number;
  /** Why the batch started nothing, if it did not. */
  stoppedBy: "sandbox_unavailable" | null;
  sandboxUnavailableReason: string | null;
};

export async function recordMcpStdioBatch(
  summary: McpStdioBatchSummary,
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
    logger.warn("Could not record the MCP stdio validation batch summary", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function readLastMcpStdioBatch(): Promise<McpStdioBatchSummary | null> {
  const redis = await jobsRedisClient();
  const value = await redis.get(LAST_BATCH_KEY);
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as McpStdioBatchSummary;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sandboxes in flight, so an orphan can be found
// ---------------------------------------------------------------------------

/**
 * The validation creates its sandboxes outside the agent sandbox manager (it
 * has no thread or workspace to record them under), so nothing in the
 * database knows them. This ledger does: a sandbox is recorded before it is
 * used and removed once deleted. A worker that dies in between leaves its
 * entry, and the next batch deletes the sandbox it names
 * (`worker/processors/mcp-stdio-sandbox.ts`). Cloudflare enforces no TTL of
 * its own, so without this an orphan would live until someone noticed.
 */
const IN_FLIGHT_SANDBOXES_KEY = "sourceweft:mcp-stdio-validate:sandboxes";

export type McpStdioInFlightSandbox = {
  provider: string;
  providerSandboxId: string;
  createdAt: string;
};

export async function recordMcpStdioSandbox(
  entry: McpStdioInFlightSandbox,
): Promise<void> {
  const redis = await jobsRedisClient();
  await redis.hset(
    IN_FLIGHT_SANDBOXES_KEY,
    entry.providerSandboxId,
    JSON.stringify(entry),
  );
}

export async function forgetMcpStdioSandbox(
  providerSandboxId: string,
): Promise<void> {
  const redis = await jobsRedisClient();
  await redis.hdel(IN_FLIGHT_SANDBOXES_KEY, providerSandboxId);
}

/** Every sandbox recorded and not yet forgotten, whatever its age. */
export async function listMcpStdioSandboxes(): Promise<
  McpStdioInFlightSandbox[]
> {
  const redis = await jobsRedisClient();
  const entries = await redis.hgetall(IN_FLIGHT_SANDBOXES_KEY);
  const sandboxes: McpStdioInFlightSandbox[] = [];
  for (const [providerSandboxId, value] of Object.entries(entries)) {
    try {
      const parsed = JSON.parse(value) as Partial<McpStdioInFlightSandbox>;
      sandboxes.push({
        providerSandboxId,
        provider: typeof parsed.provider === "string" ? parsed.provider : "",
        createdAt:
          typeof parsed.createdAt === "string"
            ? parsed.createdAt
            : new Date(0).toISOString(),
      });
    } catch {
      sandboxes.push({
        providerSandboxId,
        provider: "",
        createdAt: new Date(0).toISOString(),
      });
    }
  }
  return sandboxes;
}
