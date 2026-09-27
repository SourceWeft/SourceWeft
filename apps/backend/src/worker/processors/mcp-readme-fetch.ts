import type { Job } from "bullmq";
import {
  fetchMcpReadmeBatch,
  type FetchMcpReadmeBatchDeps,
} from "../../modules/market/readme/readme-fetch";
import type {
  McpReadmeBatchSummary,
  McpReadmeFetchJobPayload,
} from "../../modules/market/readme/readme-queue";

/**
 * One batch of MCP server READMEs (`mcp-readme-fetch`). Per-version failures
 * are stored on the versions and never fail the job; a thrown error (the
 * database is down) fails it, and the versions it did not reach stay due for
 * the next scheduled batch.
 */
export async function processMcpReadmeFetchJob(
  job: Job<Record<string, unknown>>,
  deps?: FetchMcpReadmeBatchDeps,
): Promise<McpReadmeBatchSummary> {
  const payload = job.data as Partial<McpReadmeFetchJobPayload>;
  const versionIds = payload.versionIds;
  if (
    !Array.isArray(versionIds) ||
    !versionIds.every((id) => typeof id === "string" && id)
  ) {
    throw new Error("mcp-readme-fetch job has no versionIds");
  }
  const reason = payload.reason === "admin" ? "admin" : "scheduled";
  return fetchMcpReadmeBatch({ versionIds, reason }, deps);
}
