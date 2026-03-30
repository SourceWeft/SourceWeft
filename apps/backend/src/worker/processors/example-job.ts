import type { Job } from "bullmq";

export async function processExampleJob(_job: Job<Record<string, unknown>>) {
  // Skeleton only: no business execution yet.
}
