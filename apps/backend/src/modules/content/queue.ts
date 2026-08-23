import type { DeliverableJobEnvelope } from "@sourceweft/capability-contracts";
import { config } from "../../shared/config";
import {
  deliverablesQueue,
  enqueueWithAudit,
  jobsQueue,
} from "../../shared/queue";
import type {
  LlmExecutionConfig,
  LlmThinkingConfig,
} from "./model-gateway-audit";

export const SOURCE_PARSE_JOB = "source-parse";
export const SOURCE_PARSE_POLL_JOB = "source-parse-poll";
export const CONNECTOR_SYNC_JOB = "connector-sync";
export const THREAD_TITLE_GENERATE_JOB = "thread-title-generate";
export const THREAD_CHAT_RUN_JOB = "thread-chat-run";
export const SOURCE_PARSE_JOB_ATTEMPTS = 2;
export const DELIVERABLES_QUEUE_JOB_ATTEMPTS = 1;
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
  /**
   * Thinking config of the originating chat turn, carried so the worker can
   * force reasoning OFF for the title while keeping the model's
   * `supportedParameters`. See `generateThreadTitle`.
   */
  thinking?: LlmThinkingConfig;
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
  targetExternalIds?: string[];
};

/**
 * Payload of a deliverable job, as the dispatch side sees it.
 *
 * The base is the same `DeliverableJobEnvelope` the worker host consumes — the
 * two halves of one round trip, declared once in `capability-contracts`. Fields
 * beyond it are the dispatching capability's own business (a request key, a
 * narration flag, whatever its pipeline reads back out of `request`): they are
 * carried through untouched and never interpreted here.
 */
export type DeliverableJobPayload = DeliverableJobEnvelope & {
  readonly llm?: LlmExecutionConfig;
  readonly [key: string]: unknown;
};

export type EnqueueDeliverableJobInput = {
  /**
   * BullMQ job name, supplied by the capability from its own manifest
   * (`contributes.tools[].runtime.pipeline.jobName`) — the same field the
   * worker's pipeline registry reads to build its processor map.
   */
  readonly jobName: string;
  /** Idempotency key: one job id, one run. */
  readonly jobId: string;
  readonly payload: DeliverableJobPayload;
};

export type ThreadChatRunJobResult =
  | {
      status: "completed" | "waiting_for_approval";
      runId: string;
      assistantMessageId: string | null;
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
      // A title is best-effort with a first-message fallback, so cap retries
      // low: without this a slow/erroring model turned into ~30s of backoff.
      attempts: 2,
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

export async function enqueueThreadChatRunJob(
  payload: ThreadChatRunJobPayload,
) {
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

export async function enqueueConnectorSyncJob(
  payload: ConnectorSyncJobPayload,
) {
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

/**
 * Dispatch half of the deliverable round trip: capability-agnostic.
 *
 * The host names no capability and no job — it takes the job name the
 * capability declared, the id it chose, and the payload it built, applies the
 * deliverables queue's shared retry/idempotency policy, and enqueues. An
 * existing non-failed job is returned as is; a failed one is retried in place.
 */
export async function enqueueDeliverableJob({
  jobName,
  jobId,
  payload,
}: EnqueueDeliverableJobInput) {
  const existing = await deliverablesQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state !== "failed") {
      return existing;
    }
    await existing.retry("failed", {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
    return existing;
  }

  try {
    return await enqueueWithAudit(
      jobName,
      payload,
      {
        jobId,
        attempts: DELIVERABLES_QUEUE_JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
      {
        queue: deliverablesQueue,
        queueName: config.deliverablesQueueName,
      },
    );
  } catch (error) {
    const duplicate = await deliverablesQueue.getJob(jobId);
    if (duplicate) {
      return duplicate;
    }
    throw error;
  }
}
