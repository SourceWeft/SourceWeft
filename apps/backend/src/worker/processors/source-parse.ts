import type { Job } from "bullmq";
import { contentService } from "../../modules/content";
import type { SourceParseJobPayload } from "../../modules/content/queue";

export async function processSourceParseJob(job: Job<Record<string, unknown>>) {
  await contentService.processSourceParseJob(job.data as SourceParseJobPayload);
}
