import type { Job } from "bullmq";
import { syncModelPricing } from "../../shared/scripts/sync-model-pricing";

export async function processSyncModelPricingJob(
  _job: Job<Record<string, unknown>>,
): Promise<void> {
  await syncModelPricing();
}
