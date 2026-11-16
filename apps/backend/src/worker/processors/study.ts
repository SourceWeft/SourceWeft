import type { Job } from "bullmq";
import type { StudyGenerateJobPayload } from "../../modules/content/queue";
import { processStudyJob } from "../../modules/study/job";
import { billingRuntime as billingService } from "../../billing-host/bindings";

export async function processStudyGenerateJob(
  job: Job<Record<string, unknown>>,
) {
  const payload = job.data as StudyGenerateJobPayload;
  return processStudyJob(
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
