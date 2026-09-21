import { runSkillAutoListing } from "../../modules/skills/market/auto-list";
import { refreshSkillInstallCounts } from "../../modules/skills/market/install-counts";
import { runProvenanceSweep } from "../../modules/skills/market/provenance";
import { refreshSkillRepositoryMetadata } from "../../modules/skills/market/repo-metadata";
import { logger } from "../../shared/logger";

/** How often the skill market's upkeep runs. */
export const SKILL_MARKET_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The skill market's upkeep: list skills whose scan came back clean, refresh
 * the GitHub facts of the repositories they come from, and recompute the
 * install counts and rank scores the market sorts by. Runs directly (not via
 * the job queue) for the same reason the MCP federation does — a best-effort
 * periodic pass, where the next tick picks up whatever this one missed.
 */
export async function scheduleSkillMarketUpkeep(): Promise<void> {
  // First: confirm where unstamped versions' commits come from, and withhold
  // any that are a fork's. Only confirmed versions are listed below.
  const provenance = await runProvenanceSweep();
  if (provenance.foreign > 0 || provenance.unknown > 0) {
    logger.info("Skill provenance sweep", provenance);
  }
  const listing = await runSkillAutoListing();
  // Stars feed the rank score, so they are read before it is recomputed. A
  // GitHub outage must not cost the market its install counts.
  try {
    const repositories = await refreshSkillRepositoryMetadata();
    if (repositories.failed > 0 || repositories.missing > 0) {
      logger.info("Skill repository metadata refresh", repositories);
    }
  } catch (error) {
    logger.warn("Skill repository metadata refresh failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  await refreshSkillInstallCounts();
  if (listing.listed > 0 || listing.failed > 0 || listing.backfilled > 0) {
    logger.info("Skill market upkeep complete", listing);
  }
}
