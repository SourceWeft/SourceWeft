import { isAgentQuestionRequest } from "@sourceweft/contracts";
import { ContentError } from "../../content/errors";
import { requireContentWorkspace } from "../../workspace/guards";
import { logger } from "../../../shared/logger";
import { publishThreadEvent } from "../../../shared/notify-hub";
import { ASK_USER_CANCELLED_ANSWER, formatAskUserTranscript } from "../agent";
import {
  findMessageRecord,
  updateMessageMetadataRecord,
} from "../message-repository";
import { findActiveChatThreadRun, findChatThreadRunById } from "./repository";
import {
  CLIENT_CANCELLED_CODE,
  CLIENT_CANCELLED_MESSAGE,
} from "./run-constants";

/**
 * Rewrite a parked turn's pending `askUser` calls into their unanswered
 * transcript. Returns null when the turn has no pending question.
 */
export function endPendingQuestionsInMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> | null {
  const toolCalls = Array.isArray(metadata.toolCalls) ? metadata.toolCalls : [];
  let ended = false;
  const nextToolCalls = toolCalls.map((call) => {
    const record =
      call && typeof call === "object" && !Array.isArray(call)
        ? (call as Record<string, unknown>)
        : null;
    if (!record || !isAgentQuestionRequest(record.output)) {
      return call;
    }
    ended = true;
    const { questions } = record.output;
    return {
      ...record,
      status: "completed",
      error: null,
      output: formatAskUserTranscript(
        questions,
        questions.map(() => ASK_USER_CANCELLED_ANSWER),
      ),
    };
  });
  if (!ended) {
    return null;
  }
  return {
    ...metadata,
    toolCalls: nextToolCalls,
    isCancelled: true,
    error: CLIENT_CANCELLED_MESSAGE,
    errorCode: CLIENT_CANCELLED_CODE,
  };
}

/**
 * End the turn a run parked on an `askUser` question, the way End ends a turn
 * parked on an approval: the question is recorded unanswered and the turn
 * stopped, and the model is not called again. (Cancel, by contrast, answers
 * "cancelled" and lets the assistant continue.)
 *
 * A question pause leaves its run `completed`, so there is no run to stop; the
 * durable record of the pending question is the turn's assistant message, and
 * that is what this rewrites. Only the run's own initiator may end it, and not
 * while a run is active on the thread — an answer may already be resuming it.
 * Ending a turn with no pending question is a no-op.
 */
export async function endPendingQuestions(input: {
  workspaceId: string;
  threadId: string;
  userId: string;
  threadRunId: string;
  assistantMessageId: string;
}) {
  const workspace = await requireContentWorkspace(input);
  const scope = {
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
  };
  const run = await findChatThreadRunById({
    runId: input.threadRunId,
    ...scope,
  });
  if (
    !run ||
    run.threadId !== input.threadId ||
    run.userId !== input.userId ||
    run.assistantMessageId !== input.assistantMessageId
  ) {
    throw new ContentError(404, "CHAT_RUN_NOT_FOUND", "Chat run not found");
  }
  const active = await findActiveChatThreadRun({
    ...scope,
    threadId: input.threadId,
  });
  if (active) {
    throw new ContentError(
      409,
      "CHAT_RUN_ALREADY_ACTIVE",
      "A chat run is already active for this thread",
    );
  }
  const message = await findMessageRecord({
    ...scope,
    messageId: input.assistantMessageId,
  });
  if (!message || message.threadId !== input.threadId) {
    throw new ContentError(404, "MESSAGE_NOT_FOUND", "Message not found");
  }
  const metadata = endPendingQuestionsInMetadata(message.metadata ?? {});
  if (!metadata) {
    return { ended: false };
  }
  await updateMessageMetadataRecord({
    ...scope,
    threadId: input.threadId,
    messageId: message.id,
    metadata,
  });
  void publishThreadEvent({
    threadId: input.threadId,
    workspaceId: workspace.id,
    kind: "message_updated",
    messageId: message.id,
    role: "assistant",
    actorUserId: input.userId,
  }).catch((error) => {
    logger.warn("Failed to publish thread message event", {
      threadId: input.threadId,
      messageId: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return { ended: true };
}
