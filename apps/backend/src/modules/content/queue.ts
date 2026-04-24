import type { Job } from "bullmq";
import { jobsQueue } from "../../shared/queue";

export const SOURCE_PARSE_JOB = "source-parse";

export type SourceParseJobPayload = {
  sourceId: string;
  workspaceId: string;
  teamId: string;
  userId: string;
  idempotencyKey?: string;
};

export async function enqueueSourceParseJob(payload: SourceParseJobPayload) {
  return jobsQueue.add(SOURCE_PARSE_JOB, payload, {
    jobId: payload.idempotencyKey,
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}

export function isSourceParseJob(job: Job<Record<string, unknown>>): job is Job<SourceParseJobPayload> {
  return job.name === SOURCE_PARSE_JOB;
}
