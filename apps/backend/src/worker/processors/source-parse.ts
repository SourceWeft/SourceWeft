import type { Job } from "bullmq";
import { sourceParsingService } from "../../modules/sources";
import type {
  SourceParseJobPayload,
  SourceParsePollJobPayload,
} from "../../modules/content/queue";

function isFinalAttempt(job: Job<Record<string, unknown>>) {
  const maxAttempts = job.opts.attempts ?? 1;
  return job.attemptsMade + 1 >= maxAttempts;
}

export async function processSourceParseJob(job: Job<Record<string, unknown>>) {
  await sourceParsingService.processSourceParseJob({
    ...(job.data as SourceParseJobPayload),
    isFinalAttempt: isFinalAttempt(job),
  });
}

export async function processSourceParsePollJob(job: Job<Record<string, unknown>>) {
  await sourceParsingService.processSourceParsePollJob({
    ...(job.data as SourceParsePollJobPayload),
    isFinalAttempt: isFinalAttempt(job),
  });
}
