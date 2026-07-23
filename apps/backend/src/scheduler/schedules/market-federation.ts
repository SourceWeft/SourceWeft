import { runMarketFederation } from "../../modules/market/federation";
import { logger } from "../../shared/logger";

/**
 * Federate the MCP catalog from the configured upstream registries. Runs
 * directly (not via the job queue) on its own long interval, since it is a
 * best-effort periodic refresh rather than a per-request task.
 */
export async function scheduleMarketFederation(): Promise<void> {
  logger.info("Running market federation sync");
  const results = await runMarketFederation();
  logger.info("Market federation sync complete", { results });
}
