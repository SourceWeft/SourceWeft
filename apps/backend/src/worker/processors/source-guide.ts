import type { Job } from "bullmq";
import { processSourceGuideJob } from "../../modules/sources/guide-service";
import type { SourceGuideGenerateJobPayload } from "../../modules/content/queue";
import { billingRuntime as billingService } from "../../billing-host/bindings";

export async function processSourceGuideGenerateJob(
  job: Job<Record<string, unknown>>,
) {
  const payload = job.data as SourceGuideGenerateJobPayload;
  return processSourceGuideJob(
    {
      ...payload,
      isFinalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
      scopeId: String(job.id ?? `${payload.sourceId}:${job.timestamp}`),
    },
    { billing: billingService },
  );
}
