import type { Job } from "bullmq";
import { contentService } from "../../modules/content";
import type {
  SourceParseJobPayload,
  SourceParsePollJobPayload,
} from "../../modules/content/queue";

export async function processSourceParseJob(job: Job<Record<string, unknown>>) {
  await contentService.processSourceParseJob(job.data as SourceParseJobPayload);
}

export async function processSourceParsePollJob(job: Job<Record<string, unknown>>) {
  await contentService.processSourceParsePollJob(job.data as SourceParsePollJobPayload);
}
