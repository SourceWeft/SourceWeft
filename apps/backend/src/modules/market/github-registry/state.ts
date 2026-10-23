import { logger } from "../../../shared/logger";
import { jobsRedisClient } from "../../../shared/queue";
import type { GithubRegistryFetchStop } from "./fetch";

/**
 * The last pass, kept in Redis the way the README fetch keeps its last batch:
 * the scheduler paces passes by its `finishedAt`, and an admin can see what
 * the last one did.
 */

const LAST_PASS_KEY = "sourceweft:mcp-github-registry:last-pass";
const LAST_PASS_TTL_SECONDS = 30 * 24 * 60 * 60;

export type GithubRegistryPassSummary = {
  startedAt: string;
  finishedAt: string;
  /** Pages requested, and rows read from them. */
  pages: number;
  rows: number;
  /** Null when the walk reached the registry's last page. */
  stoppedBy: GithubRegistryFetchStop | null;
  error?: string;
  /** Catalog entries a row could annotate. */
  targets: number;
  matched: { name: number; endpointDomainOrg: number };
  /** Records written, and how many of them changed the manifest too. */
  written: number;
  manifestPatched: number;
  /** Matches whose write failed; the next pass tries them again. */
  failed: number;
};

export async function recordGithubRegistryPass(
  summary: GithubRegistryPassSummary,
): Promise<void> {
  try {
    const redis = await jobsRedisClient();
    await redis.set(
      LAST_PASS_KEY,
      JSON.stringify(summary),
      "EX",
      LAST_PASS_TTL_SECONDS,
    );
  } catch (error) {
    // The records are in the database either way; only the pacing marker and
    // the admin summary are missing, and the next tick runs a pass again.
    logger.warn("Could not record the GitHub MCP Registry pass", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function readLastGithubRegistryPass(): Promise<GithubRegistryPassSummary | null> {
  const redis = await jobsRedisClient();
  const value = await redis.get(LAST_PASS_KEY);
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as GithubRegistryPassSummary;
  } catch {
    return null;
  }
}
