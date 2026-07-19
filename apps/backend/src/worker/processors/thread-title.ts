import type { Job } from "bullmq";
import { logger } from "../../shared/logger";
import type {
  ThreadTitleGenerateJobPayload,
  ThreadTitleGenerateJobResult,
} from "../../modules/content/queue";
import {
  applyGeneratedThreadTitle,
  buildFallbackThreadTitle,
  generateThreadTitle,
} from "../../modules/threads";
import { findThreadRecord } from "../../modules/threads";
import { contentByokService } from "../../modules/byok";
import { billingService } from "../../modules/billing";
import type { LlmExecutionConfig } from "../../modules/content/model-gateway-audit";

async function resolveThreadTitleExecution(
  payload: ThreadTitleGenerateJobPayload,
): Promise<LlmExecutionConfig | undefined> {
  if (payload.llm?.executionMode !== "BYOK" || !payload.llm.byokModelId) {
    return undefined;
  }

  const resolved = await contentByokService.resolveByokModelExecution({
    workspaceId: payload.workspaceId,
    userId: payload.userId,
    byokModelId: payload.llm.byokModelId,
  });

  if (resolved.modelType !== "llm") {
    throw new Error("BYOK title generation requires a llm model");
  }

  return {
    executionMode: "BYOK",
    profileAlias: undefined,
    modelAlias: resolved.displayName,
    providerModel: resolved.modelName,
    providerHint: resolved.providerName,
    byokModelId: resolved.byokModelId,
    credentialId: resolved.credentialId,
    byok: {
      provider: resolved.providerName,
      providerKind: resolved.providerKind,
      ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
      apiKey: resolved.apiKey,
      defaultHeaders: resolved.defaultHeaders,
    },
  };
}

export async function processThreadTitleGenerateJob(
  job: Job<Record<string, unknown>>,
): Promise<ThreadTitleGenerateJobResult> {
  const payload = job.data as ThreadTitleGenerateJobPayload;
  const thread = await findThreadRecord({
    threadId: payload.threadId,
    teamId: payload.teamId,
    workspaceId: payload.workspaceId,
  });

  if (!thread) {
    logger.warn("Skipped automatic thread title job for missing thread", {
      threadId: payload.threadId,
      userMessageId: payload.userMessageId,
    });
    return {
      status: "skipped",
      threadId: payload.threadId,
      reason: "missing-thread",
    };
  }

  if (thread.title !== payload.expectedTitle) {
    logger.debug("Skipped automatic thread title job for renamed thread", {
      threadId: payload.threadId,
      userMessageId: payload.userMessageId,
      currentTitle: thread.title,
      expectedTitle: payload.expectedTitle,
    });
    return {
      status: "skipped",
      threadId: payload.threadId,
      reason: "renamed-thread",
    };
  }

  const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  let title: string | null = null;

  try {
    const llm = await resolveThreadTitleExecution(payload);
    title = await generateThreadTitle({
      ...payload,
      providerModel: llm?.providerModel ?? payload.providerModel,
      llm,
      // The job payload is serialised through BullMQ and cannot carry a port,
      // so the processor supplies the same singleton the in-process path uses.
      billing: billingService,
    });
  } catch (error) {
    if (!isLastAttempt) {
      throw error;
    }
    logger.warn("Automatic thread title generation exhausted retries", {
      threadId: payload.threadId,
      userMessageId: payload.userMessageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  title ??= buildFallbackThreadTitle(payload.messageContent);

  const updated = await applyGeneratedThreadTitle({
    ...payload,
    title,
  });

  if (updated) {
    logger.info("Automatic thread title job applied title", {
      threadId: payload.threadId,
      userMessageId: payload.userMessageId,
      title: updated.title,
    });
    return {
      status: "applied",
      threadId: payload.threadId,
      title: updated.title,
    };
  }

  return {
    status: "skipped",
    threadId: payload.threadId,
    reason: "empty-title",
  };
}
