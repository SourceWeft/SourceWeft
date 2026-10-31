import { DelayedError, type Job } from "bullmq";
import {
  assertMarketAiWindow,
  MarketAiDeferredError,
} from "../shared/market-ai-schedule";
import { logger } from "../shared/logger";

const MARKET_AI_JOBS = new Set([
  "mcp-overview-generate",
  "skill-overview-generate",
  "mcp-summary-translation",
]);

/** Defer only market AI jobs; tenant work keeps its slots and normal retries. */
export async function runMarketAiJob<T>(
  job: Job<Record<string, unknown>>,
  processor: (job: Job<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  if (!MARKET_AI_JOBS.has(job.name)) return processor(job);
  try {
    assertMarketAiWindow();
    return await processor(job);
  } catch (error) {
    if (!(error instanceof MarketAiDeferredError)) throw error;
    await job.moveToDelayed(error.resumeAt.getTime(), job.token);
    logger.info("Market AI job deferred until off-peak", {
      jobId: String(job.id),
      type: job.name,
      resumeAt: error.resumeAt.toISOString(),
    });
    // BullMQ does not increment attemptsMade for DelayedError.
    throw new DelayedError();
  }
}
