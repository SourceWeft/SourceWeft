import type { Job } from "bullmq";
import type { TableGenerateJobPayload } from "../../modules/content/queue";
import { processTableJob } from "../../modules/tables/job";
import { billingRuntime as billingService } from "../../billing-host/bindings";

export async function processTableGenerateJob(
  job: Job<Record<string, unknown>>,
) {
  const payload = job.data as TableGenerateJobPayload;
  return processTableJob(
    {
      ...payload,
      isFinalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
      scopeId: String(
        job.id ?? `${payload.artifactId}:${payload.versionNo}:${job.timestamp}`,
      ),
    },
    { billing: billingService },
  );
}
