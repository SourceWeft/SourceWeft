import type { Job } from "bullmq";
import type { ThreadChatRunJobPayload } from "../../modules/content/queue";
import { processThreadChatRunJob as processDurableThreadChatRunJob } from "../../modules/threads";
import { ContentError } from "../../modules/content/errors";
import { persistTerminalFailure } from "../../modules/threads/durable/runner";
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

  return persistTerminalFailure({
    run,
    status: contentError.code === "CLIENT_CANCELLED" ? "cancelled" : "failed",
    assistantMessageId: run.assistantMessageId,
    snapshot,
    contentError,
    appendRunEvent: durableChatRunService.appendRunEvent.bind(
      durableChatRunService,
    ),
    finishRun: durableChatRunService.finishRun.bind(durableChatRunService),
  });
}

export async function processThreadChatRunJob(
  job: Job<Record<string, unknown>>,
) {
  const payload = job.data as ThreadChatRunJobPayload;
  try {
    return await processDurableThreadChatRunJob(payload);
  } catch (error) {
    try {
      await failThreadRunAtProcessorBoundary({ payload, error });
    } catch (terminalError) {
      logger.error("Failed to finalize thread run at processor boundary", {
        runId: payload.runId,
        error:
          terminalError instanceof Error
            ? terminalError.message
            : String(terminalError),
      });
    }
    throw error;
  }
}

export const testExports = {
  failThreadRunAtProcessorBoundary,
  toContentRunError,
};
