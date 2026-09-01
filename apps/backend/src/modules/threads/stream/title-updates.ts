/**
 * Automatic thread-title generation around a stream run: whether a turn
 * should title the thread, enqueueing the title job, waiting on its
 * completion, and turning a completion into a title-update event.
 *
 * Carved out of `service.ts` verbatim (T2.3 mechanical split); behavior
 * unchanged.
 */
import type { Job } from "bullmq";
import { getJobsQueueEvents } from "../../../shared/queue";
import { logger } from "../../../shared/logger";
import type {
  ThreadTitleGenerateJobPayload,
  ThreadTitleGenerateJobResult,
} from "../../content/queue";
import type { ContentThreadTurnService } from "../turn/service";

export type ThreadTitleJob = Job<Record<string, unknown>, unknown, string>;

export type ThreadTitleJobCompletion = {
  jobId: string;
  result: ThreadTitleGenerateJobResult | null;
};

export function shouldGenerateAutomaticThreadTitle(
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>,
) {
  return prepared.isFirstAssistantResponse && prepared.isFirstAssistantAttempt;
}

function isThreadTitleGenerateJobResult(
  value: unknown,
): value is ThreadTitleGenerateJobResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const result = value as Record<string, unknown>;
  return (
    (result.status === "applied" || result.status === "skipped") &&
    typeof result.threadId === "string"
  );
}

export function titleCompletionToUpdate(completion: ThreadTitleJobCompletion) {
  return completion.result?.status === "applied"
    ? {
        id: completion.result.threadId,
        title: completion.result.title,
      }
    : null;
}

export async function waitForThreadTitleJob(input: {
  job: ThreadTitleJob;
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>;
}): Promise<ThreadTitleJobCompletion> {
  const jobId = String(input.job.id);
  try {
    const waitUntilFinished = input.job.waitUntilFinished.bind(input.job) as (
      queueEvents?: ReturnType<typeof getJobsQueueEvents>,
    ) => Promise<unknown>;
    const result =
      waitUntilFinished.length === 0
        ? await waitUntilFinished()
        : await waitUntilFinished(getJobsQueueEvents());
    return {
      jobId,
      result: isThreadTitleGenerateJobResult(result) ? result : null,
    };
  } catch (error) {
    logger.warn("Automatic thread title job failed", {
      threadId: input.prepared.thread.id,
      userMessageId: input.prepared.userMessage.id,
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { jobId, result: null };
  }
}

export async function enqueueAutomaticThreadTitleJob(input: {
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>;
}): Promise<ThreadTitleJob | null> {
  if (!shouldGenerateAutomaticThreadTitle(input.prepared)) {
    return null;
  }

  const { enqueueThreadTitleGenerateJob } = await import("../../content/queue");
  const payload: ThreadTitleGenerateJobPayload = {
    teamId: input.prepared.workspace.organizationId,
    workspaceId: input.prepared.workspace.id,
    threadId: input.prepared.thread.id,
    traceId: input.prepared.traceContext?.traceId,
    userId: input.prepared.userId,
    userMessageId: input.prepared.userMessage.id,
    messageContent: input.prepared.messageContent,
    profileAlias: input.prepared.profileAlias,
    modelAlias: input.prepared.modelAlias,
    providerModel: input.prepared.providerModel,
    gatewayConfigId: input.prepared.chatProfile.gatewayConfigId,
    expectedTitle: input.prepared.initialTitle,
    thinking: input.prepared.llm?.thinking,
    ...(input.prepared.llm?.executionMode === "BYOK" &&
    input.prepared.llm.byokModelId
      ? {
          llm: {
            executionMode: "BYOK" as const,
            byokModelId: input.prepared.llm.byokModelId,
            credentialId: input.prepared.llm.credentialId,
            providerHint: input.prepared.llm.providerHint,
            providerModel: input.prepared.llm.providerModel,
            modelAlias: input.prepared.llm.modelAlias,
          },
        }
      : {}),
  };

  return enqueueThreadTitleGenerateJob(payload).catch((error: unknown) => {
    logger.warn("Failed to enqueue automatic thread title job", {
      threadId: input.prepared.thread.id,
      userMessageId: input.prepared.userMessage.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
}
