import {
  runSummaryTranslationPass,
  type SummaryTranslationDeps,
} from "../../modules/market/metadata/summary-translation-run";
import { logger } from "../../shared/logger";

/**
 * One pass of the MCP summary translation (`mcp-summary-translation`):
 * a small batch of entries without an AI overview, translated into Chinese on
 * the system model. A pass does nothing while the system model is not ready.
 * One entry's failure is stored on its version; a thrown error (the database
 * is down) fails the job, and what it left is still due on the next tick.
 */
export async function processMcpSummaryTranslationJob(
  deps?: SummaryTranslationDeps,
) {
  const result = await runSummaryTranslationPass({}, deps);
  const outcomes: Record<string, number> = {};
  for (const report of result.reports) {
    outcomes[report.outcome] = (outcomes[report.outcome] ?? 0) + 1;
  }
  if (result.reports.length > 0) {
    logger.info("MCP summary translation pass complete", { outcomes });
  }
  return { skipped: result.skipped, outcomes };
}
