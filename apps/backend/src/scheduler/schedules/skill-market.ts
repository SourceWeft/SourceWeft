import { reconcileSkillInstallReferences } from "../../modules/skills/registry/install-references";
import { runSkillAutoListing } from "../../modules/skills/market/auto-list";
import { refreshSkillInstallCounts } from "../../modules/skills/market/install-counts";
import { enqueueSkillOverviews } from "../../modules/skills/market/overviews";
import { runProvenanceSweep } from "../../modules/skills/market/provenance";
import { refreshSkillRepositoryMetadata } from "../../modules/skills/market/repo-metadata";
import { refreshSkillRatings } from "../../modules/skills/market/reviews";
import { refreshSkillRunStats } from "../../modules/skills/market/run-stats";
import { logger } from "../../shared/logger";

/** How often the skill market's upkeep runs. */
export const SKILL_MARKET_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Until when the two GitHub-backed passes (provenance, repository metadata)
 * are skipped. Set when either reports GitHub's rate limit: the limit is the
 * token's and resets hourly, so a tick before that would spend one request to
 * meet it again and warn again — 165 ticks of 165, in production, once.
 * Process-local, like the schedule's timer: a restart asks once and learns.
 */
let githubPausedUntil: Date | null = null;
/** Whether the pause in effect has been logged; one line per pause, not per tick. */
let githubPauseLogged = false;

/** For tests: forget a pause left by an earlier tick. */
export function resetSkillMarketGitHubPause(): void {
  githubPausedUntil = null;
  githubPauseLogged = false;
}

function pauseGitHubUntil(rateLimitedUntil: string | undefined): void {
  if (!rateLimitedUntil) return;
  const until = new Date(rateLimitedUntil);
  if (Number.isNaN(until.getTime())) return;
  if (githubPausedUntil && githubPausedUntil >= until) return;
  githubPausedUntil = until;
  githubPauseLogged = false;
}

/** Whether GitHub is still off limits for this tick; forgets a pause that has lifted. */
function githubPaused(now: Date): boolean {
  if (!githubPausedUntil) return false;
  if (now < githubPausedUntil) return true;
  githubPausedUntil = null;
  githubPauseLogged = false;
  return false;
}

/**
 * The skill market's upkeep: list skills whose scan came back clean, refresh
 * the GitHub facts of the repositories they come from, and recompute the
 * install counts and rank scores the market sorts by. Runs directly (not via
 * the job queue) for the same reason the MCP federation does — a best-effort
 * periodic pass, where the next tick picks up whatever this one missed.
 */
export async function scheduleSkillMarketUpkeep(): Promise<void> {
  if (githubPaused(new Date()) && !githubPauseLogged) {
    githubPauseLogged = true;
    logger.info(
      "Skill market GitHub passes paused until the rate limit resets",
      {
        until: githubPausedUntil?.toISOString(),
      },
    );
  }
  // First: confirm where unstamped versions' commits come from, and withhold
  // any that are a fork's. Only confirmed versions are listed below.
  if (!githubPaused(new Date())) {
    const provenance = await runProvenanceSweep();
    if (provenance.foreign > 0 || provenance.unknown > 0) {
      logger.info("Skill provenance sweep", provenance);
    }
    pauseGitHubUntil(provenance.rateLimitedUntil);
  }
  const listing = await runSkillAutoListing();
  // Stars feed the rank score, so they are read before it is recomputed. A
  // GitHub outage must not cost the market its install counts.
  if (!githubPaused(new Date())) {
    try {
      const repositories = await refreshSkillRepositoryMetadata();
      if (repositories.failed > 0 || repositories.missing > 0) {
        logger.info("Skill repository metadata refresh", repositories);
      }
      pauseGitHubUntil(repositories.rateLimitedUntil);
    } catch (error) {
      logger.warn("Skill repository metadata refresh failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // Ratings feed the rank score too.
  await refreshSkillRatings();
  await refreshSkillInstallCounts();
  // Each independent of the others: one failing costs only its own numbers.
  for (const [name, step] of [
    ["install references", reconcileSkillInstallReferences],
    ["run stats", refreshSkillRunStats],
    ["overview queue", enqueueSkillOverviews],
  ] as const) {
    try {
      await step();
    } catch (error) {
      logger.warn(`Skill market ${name} step failed`, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (listing.listed > 0 || listing.failed > 0 || listing.backfilled > 0) {
    logger.info("Skill market upkeep complete", listing);
  }
}
