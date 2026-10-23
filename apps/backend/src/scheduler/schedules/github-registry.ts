import { runGithubRegistryEnrichment } from "../../modules/market/github-registry/enrich";
import {
  readLastGithubRegistryPass,
  type GithubRegistryPassSummary,
} from "../../modules/market/github-registry/state";
import { logger } from "../../shared/logger";

/**
 * How often the scheduler asks whether a GitHub MCP Registry pass is due. A
 * pass is due once a day (`GITHUB_REGISTRY_PASS_INTERVAL_MS` after the last
 * one finished), checked on this shorter tick so a scheduler that restarts
 * neither runs a pass per restart nor waits a day past a missed one. The
 * registry's anonymous rate limit is a few requests an hour, and a pass is
 * about seven, so the tick is never shorter than an hour.
 */
export const GITHUB_REGISTRY_TICK_INTERVAL_MS = 60 * 60 * 1000;

/** The pace of passes: once a day. */
export const GITHUB_REGISTRY_PASS_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type ScheduleGithubRegistryDeps = {
  readLastPass: () => Promise<GithubRegistryPassSummary | null>;
  run: () => Promise<GithubRegistryPassSummary>;
  now: () => Date;
};

const defaultDeps: ScheduleGithubRegistryDeps = {
  readLastPass: readLastGithubRegistryPass,
  run: () => runGithubRegistryEnrichment(),
  now: () => new Date(),
};

/**
 * Whether a pass is due: none is recorded, the last one finished a day or
 * more ago, or the last one read nothing (its first request failed, so it
 * annotated nothing and is not the day's pass). A pass that stopped early
 * with rows counts: it annotated what it read, and the next day's reads the
 * rest. A pacing marker that cannot be read (Redis down) counts as none: a
 * pass is a handful of requests, and the marker is written again after it.
 */
export async function githubRegistryPassDue(
  deps: ScheduleGithubRegistryDeps,
): Promise<boolean> {
  let last: GithubRegistryPassSummary | null;
  try {
    last = await deps.readLastPass();
  } catch (error) {
    logger.warn("Could not read the last GitHub MCP Registry pass", {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
  if (!last || last.rows === 0) return true;
  const finishedAt = new Date(last.finishedAt).getTime();
  if (!Number.isFinite(finishedAt)) return true;
  return deps.now().getTime() - finishedAt >= GITHUB_REGISTRY_PASS_INTERVAL_MS;
}

/** Run the daily GitHub MCP Registry enrichment pass when one is due. */
export async function scheduleGithubRegistryEnrichment(
  deps: ScheduleGithubRegistryDeps = defaultDeps,
): Promise<{ ran: boolean; summary?: GithubRegistryPassSummary }> {
  if (!(await githubRegistryPassDue(deps))) {
    return { ran: false };
  }
  logger.info("Running GitHub MCP Registry enrichment pass");
  const summary = await deps.run();
  return { ran: true, summary };
}
