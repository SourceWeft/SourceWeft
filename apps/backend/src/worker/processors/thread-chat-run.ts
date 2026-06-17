import type { Job } from "bullmq";
import type { ThreadChatRunJobPayload } from "../../modules/content/queue";
import { processThreadChatRunJob as processDurableThreadChatRunJob } from "../../modules/threads";
import { ContentError } from "../../modules/content/errors";
import { toSseData } from "../../modules/threads";
import { durableChatRunService } from "../../modules/threads";
import { findChatThreadRunById } from "../../modules/threads";
import { logger } from "../../shared/logger";

function toContentRunError(error: unknown) {
  if (error instanceof ContentError) {
    return error;
  }
  return new ContentError(
    500,
    "CHAT_RUN_FAILED",
    error instanceof Error ? error.message : String(error),
  );
}

export async function failThreadRunAtProcessorBoundary(input: {
  payload: ThreadChatRunJobPayload;
  error: unknown;
}) {
  const run = await findChatThreadRunById({
    runId: input.payload.runId,
    teamId: input.payload.teamId,
    workspaceId: input.payload.workspaceId,
  });
  if (!run || ["completed", "failed", "cancelled"].includes(run.status)) {
    return null;
  }

  const contentError = toContentRunError(input.error);
  const snapshot =
    run.snapshotJson && typeof run.snapshotJson === "object"
      ? {
          ...run.snapshotJson,
          errorCode: contentError.code,
          errorMessage: contentError.message,
        }
      : {
          errorCode: contentError.code,
          errorMessage: contentError.message,
        };

  try {
    await durableChatRunService.appendRunEvent({
      run,
      payload: toSseData({
        type: "error",
        code: contentError.code,
        error: contentError.message,
        ...(run.userMessageId ? { userMessageId: run.userMessageId } : {}),
        ...(run.assistantMessageId
          ? { messageId: run.assistantMessageId }
          : {}),
      }),
      snapshot,
    });
    await durableChatRunService.appendRunEvent({
      run,
      payload: toSseData({ type: "finish" }),
      snapshot,
    });
  } catch (eventError) {
    logger.error("Failed to append terminal thread run failure events", {
      runId: run.id,
      workspaceId: run.workspaceId,
      error:
        eventError instanceof Error ? eventError.message : String(eventError),
    });
  }

  return durableChatRunService.finishRun({
    run,
    status: contentError.code === "CLIENT_CANCELLED" ? "cancelled" : "failed",
    assistantMessageId: run.assistantMessageId,
    snapshot,
    errorCode: contentError.code,
    errorMessage: contentError.message,
  });
}

export async function processThreadChatRunJob(job: Job<Record<string, unknown>>) {
  const payload = job.data as ThreadChatRunJobPayload;
  try {
    return await processDurableThreadChatRunJob(payload);
  } catch (error) {
    await failThreadRunAtProcessorBoundary({ payload, error });
    throw error;
  }
}

export const testExports = {
  failThreadRunAtProcessorBoundary,
  toContentRunError,
};
