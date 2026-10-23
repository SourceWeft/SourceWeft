import { runMarketFederation } from "../../modules/market/federation";
import { logger } from "../../shared/logger";

// A full walk with endpoint probes takes hours and now resumes after failed
// pages; the interval timer must not start a second walk over it.
let running = false;

/**
 * Federate the MCP catalog from the configured upstream registries. Runs
 * directly (not via the job queue) on its own long interval, since it is a
 * best-effort periodic refresh rather than a per-request task. An interval
 * that fires while the previous sync is still walking is skipped.
 */
export async function scheduleMarketFederation(): Promise<boolean> {
  if (running) {
    logger.info("Market federation sync still running; skipping this interval");
    return false;
  }
  running = true;
  try {
    logger.info("Running market federation sync");
    const results = await runMarketFederation();
    logger.info("Market federation sync complete", { results });
    return true;
  } finally {
    running = false;
  }
}
