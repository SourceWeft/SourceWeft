import { enqueueMcpSummaryTranslation } from "../../modules/market/metadata/summary-translation-queue";

/**
 * Queue the next pass of MCP summary translations. Only queues: the worker
 * calls the system model, and does nothing while it is not ready. The pace is
 * the pass's own fixed batch per tick, on the AI overview's interval.
 */
export async function scheduleMcpSummaryTranslations(): Promise<void> {
  await enqueueMcpSummaryTranslation();
}
