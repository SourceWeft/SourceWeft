import type { Job } from "bullmq";
import type { ThreadChatRunJobPayload } from "../../modules/content/queue";
import { processThreadChatRunJob as processDurableThreadChatRunJob } from "../../modules/content/threads/durable/runner";

export async function processThreadChatRunJob(job: Job<Record<string, unknown>>) {
  return processDurableThreadChatRunJob(job.data as ThreadChatRunJobPayload);
}
