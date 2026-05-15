import type { Job } from "bullmq";
import { jobsQueue } from "../../shared/queue";

export const SOURCE_PARSE_JOB = "source-parse";
export const SOURCE_PARSE_POLL_JOB = "source-parse-poll";
export const CONNECTOR_SYNC_JOB = "connector-sync";
export const THREAD_TITLE_GENERATE_JOB = "thread-title-generate";
export const THREAD_CHAT_RUN_JOB = "thread-chat-run";
export const SOURCE_PARSE_JOB_ATTEMPTS = 2;
const SOURCE_PARSE_JOB_BACKOFF_MS = 5_000;

export type SourceParseJobPayload = {
  sourceId: string;
  sourceRevisionId: string;
  workspaceId: string;
  teamId: string;
  userId: string;
  idempotencyKey?: string;
  forceRefresh?: boolean;
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

export type ThreadTitleGenerateJobPayload = {
  teamId: string;
  workspaceId: string;
  threadId: string;
  traceId?: string;
  userId: string;
  userMessageId: string;
  messageContent: string;
  profileAlias: string;
  modelAlias: string;
  providerModel?: string;
  gatewayConfigId: string;
  expectedTitle: string;
  llm?: {
    executionMode: "BYOK";
    byokModelId: string;
    credentialId?: string;
    providerHint?: string;
    providerModel?: string;
    modelAlias?: string;
  };
};

export type ThreadTitleGenerateJobResult =
  | {
      status: "applied";
      threadId: string;
      title: string;
    }
  | {
      status: "skipped";
      threadId: string;
      reason: "missing-thread" | "renamed-thread" | "empty-title";
    };

export type ThreadChatRunJobPayload = {
  runId: string;
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
};

export type ConnectorSyncJobPayload = {
  runId: string;
  teamId: string;
  workspaceId: string;
  connectorId: string;
  userId: string;
};

export type ThreadChatRunJobResult =
  | {
      status: "completed";
      runId: string;
      assistantMessageId: string;
    }
  | {
      status: "cancelled" | "failed";
      runId: string;
      assistantMessageId: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
    };

export async function enqueueSourceParseJob(payload: SourceParseJobPayload) {
  return jobsQueue.add(SOURCE_PARSE_JOB, payload, {
    jobId: payload.idempotencyKey,
    attempts: SOURCE_PARSE_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: SOURCE_PARSE_JOB_BACKOFF_MS },
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
    attempts: SOURCE_PARSE_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: SOURCE_PARSE_JOB_BACKOFF_MS },
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}

export async function enqueueThreadTitleGenerateJob(
  payload: ThreadTitleGenerateJobPayload,
) {
  const jobId = `thread-title_${payload.threadId}_${payload.userMessageId}`;
  const existing = await jobsQueue.getJob(jobId);
  if (existing) {
    return existing;
  }

  try {
    return await jobsQueue.add(THREAD_TITLE_GENERATE_JOB, payload, {
      jobId,
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  } catch (error) {
    const duplicate = await jobsQueue.getJob(jobId);
    if (duplicate) {
      return duplicate;
    }
    throw error;
  }
}

export async function enqueueThreadChatRunJob(payload: ThreadChatRunJobPayload) {
  const jobId = `${THREAD_CHAT_RUN_JOB}_${payload.runId}`;
  const existing = await jobsQueue.getJob(jobId);
  if (existing) {
    return existing;
  }

  try {
    return await jobsQueue.add(THREAD_CHAT_RUN_JOB, payload, {
      jobId,
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  } catch (error) {
    const duplicate = await jobsQueue.getJob(jobId);
    if (duplicate) {
      return duplicate;
    }
    throw error;
  }
}

export async function enqueueConnectorSyncJob(payload: ConnectorSyncJobPayload) {
  const jobId = `connector_sync_${payload.connectorId}_${payload.runId}`;
  const existing = await jobsQueue.getJob(jobId);
  if (existing) {
    return existing;
  }

  try {
    return await jobsQueue.add(CONNECTOR_SYNC_JOB, payload, {
      jobId,
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  } catch (error) {
    const duplicate = await jobsQueue.getJob(jobId);
    if (duplicate) {
      return duplicate;
    }
    throw error;
  }
}

export function isSourceParseJob(job: Job<Record<string, unknown>>): job is Job<SourceParseJobPayload> {
  return job.name === SOURCE_PARSE_JOB;
}
