import type { Job } from "bullmq";
import type { ResearchJobPayload } from "../../modules/content/queue";
import { processResearchJob } from "../../modules/sources/research/job";
import { billingRuntime as billingService } from "../../billing-host/bindings";

export async function processSourceResearchJob(
  job: Job<Record<string, unknown>>,
) {
  const payload = job.data as ResearchJobPayload;
  return processResearchJob(
    {
      ...payload,
      isFinalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
      scopeId: String(job.id ?? `research:${payload.runId}:${job.timestamp}`),
    },
    { billing: billingService },
  );
}
