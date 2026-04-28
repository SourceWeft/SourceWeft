import type { Job } from "bullmq";
import { jobsQueue } from "../../shared/queue";

export const SOURCE_PARSE_JOB = "source-parse";
export const SOURCE_PARSE_POLL_JOB = "source-parse-poll";

export type SourceParseJobPayload = {
  sourceId: string;
  sourceRevisionId: string;
  workspaceId: string;
  teamId: string;
  userId: string;
  idempotencyKey?: string;
};

export type SourceParsePollJobPayload = SourceParseJobPayload & {
  backendId: string;
  taskId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  parsingConfig: {
    chunkSize: number;
    parserVersion: string;
  };
  attempt: number;
};

export async function enqueueSourceParseJob(payload: SourceParseJobPayload) {
  return jobsQueue.add(SOURCE_PARSE_JOB, payload, {
    jobId: payload.idempotencyKey,
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}

export async function enqueueSourceParsePollJob(
  payload: SourceParsePollJobPayload,
  delayMs: number,
) {
  return jobsQueue.add(SOURCE_PARSE_POLL_JOB, payload, {
    delay: delayMs,
    jobId: `${payload.idempotencyKey ?? `${SOURCE_PARSE_POLL_JOB}_${payload.sourceId}_${payload.taskId}`}_${payload.attempt}`,
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}

export function isSourceParseJob(job: Job<Record<string, unknown>>): job is Job<SourceParseJobPayload> {
  return job.name === SOURCE_PARSE_JOB;
}
