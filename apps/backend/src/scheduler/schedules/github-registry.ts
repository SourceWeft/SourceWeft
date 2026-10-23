import { runGithubRegistryEnrichment } from "../../modules/market/github-registry/enrich";
import { logger } from "../../shared/logger";

/**
 * How often the GitHub MCP Registry enrichment pass runs: once a day, and
 * once at scheduler start, like the federation sync. A pass is about seven
 * anonymous requests (the registry's anonymous rate limit is ten a window),
 * so a restart's extra pass is cheap; the registry's own facts (stars, a
 * repository's license) move slowly, so a day is often enough.
 */
export const GITHUB_REGISTRY_INTERVAL_MS = 24 * 60 * 60 * 1000;

// A pass takes seconds, but the interval timer must never start a second
// walk over one that is stuck on the network.
let running = false;

/** Run the daily GitHub MCP Registry enrichment pass, unless one is running. */
export async function scheduleGithubRegistryEnrichment(): Promise<boolean> {
  if (running) {
    logger.info(
      "GitHub MCP Registry enrichment still running; skipping this interval",
    );
    return false;
  }
  running = true;
  try {
    logger.info("Running GitHub MCP Registry enrichment pass");
    await runGithubRegistryEnrichment();
    return true;
  } finally {
    running = false;
  }
}
