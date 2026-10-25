import { enqueueMcpSummaryTranslation } from "../../modules/market/metadata/summary-translation-queue";

/**
 * Queue the next pass of MCP summary translations. Only queues, and only
 * while the system model is ready: the worker calls it. The pace is the
 * pass's own fixed batch per tick, on the AI overview's interval.
 */
export async function scheduleMcpSummaryTranslations(): Promise<void> {
  await enqueueMcpSummaryTranslation();
}
