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
} from "../../modules/content/threads/thread/title-generation";
import { findThreadRecord } from "../../modules/content/threads/thread/repository";

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
    title = await generateThreadTitle(payload);
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
