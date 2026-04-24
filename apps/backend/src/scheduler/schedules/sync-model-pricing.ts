import { jobsQueue } from "../../shared/queue";
import { logger } from "../../shared/logger";

function buildHourlyPricingJobId(date: Date) {
  const bucket = date.toISOString().slice(0, 13);
  return `sync-model-pricing-${bucket}`;
}

export async function scheduleSyncModelPricing(): Promise<void> {
  const now = new Date();
  const jobId = buildHourlyPricingJobId(now);
  logger.info("Scheduling model pricing sync job");
  await jobsQueue.add("sync-model-pricing", {
    scheduledBy: "sync-model-pricing-schedule",
    createdAt: now.toISOString(),
  }, {
    jobId,
    removeOnComplete: 20,
    removeOnFail: 50,
  });
}
