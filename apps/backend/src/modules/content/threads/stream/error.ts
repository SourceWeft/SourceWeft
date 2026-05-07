import {
  recordGatewayOperationEvent,
  type LlmExecutionConfig,
} from "../../model-gateway-audit";
import type { ContentError } from "../../errors";
import { logger } from "../../../../shared/logger";
import {
  createMessageRecord,
  deleteMessageRecord,
} from "../message-repository";
import { summarizeRetrievalCalls } from "../turn/service";
import type { PreparedThreadTurn } from "../turn/service";

export async function recordThreadStreamFailure(input: {
  prepared: PreparedThreadTurn;
  contentError: ContentError;
  operation: "chat.stream" | "chat.complete";
  llm?: LlmExecutionConfig;
}) {
  try {
    await recordGatewayOperationEvent({
      teamId: input.prepared.workspace.organizationId,
      workspaceId: input.prepared.workspace.id,
      userId: input.prepared.userId,
      threadId: input.prepared.thread.id,
      messageId: input.prepared.userMessage.id,
      feature: "chat",
      operation: input.operation,
      modelKind: "chat",
      modelAlias: input.prepared.modelAlias,
      profileAlias: input.prepared.profileAlias,
      llm: input.llm,
      traceId:
        input.prepared.traceContext?.traceId ?? input.prepared.userMessage.id,
      success: false,
      errorCode: input.contentError.code,
      errorMessage: input.contentError.message,
      attributes: {
        retrievalCalls: summarizeRetrievalCalls([]),
      },
    });
  } catch (error) {
    logger.warn("Failed to record thread stream failure audit event", {
      threadId: input.prepared.thread.id,
      userMessageId: input.prepared.userMessage.id,
      operation: input.operation,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function rollbackCreatedUserMessage(input: {
  prepared: PreparedThreadTurn;
}) {
  if (!input.prepared.createdUserMessage) {
    return;
  }

  await deleteMessageRecord({
    teamId: input.prepared.workspace.organizationId,
    workspaceId: input.prepared.workspace.id,
    threadId: input.prepared.thread.id,
    messageId: input.prepared.userMessage.id,
  });
}

export async function createThreadStreamErrorMessage(input: {
  prepared: PreparedThreadTurn;
  contentError: ContentError;
  partialAssistantContent?: string;
}) {
  if (input.prepared.failurePersistence !== "persist-error-turn") {
    return null;
  }

  const assistantContent =
    input.partialAssistantContent === undefined
      ? input.contentError.message
      : input.partialAssistantContent.trimEnd();

  return createMessageRecord({
    teamId: input.prepared.workspace.organizationId,
    workspaceId: input.prepared.workspace.id,
    threadId: input.prepared.thread.id,
    parentMessageId: input.prepared.assistantMessageParentId,
    role: "assistant",
    content: assistantContent,
    createdBy: null,
    model: input.prepared.modelAlias,
    creditsConsumed: 0,
    metadata: {
      isError: true,
      excludeFromContext: true,
      error: input.contentError.message,
      errorCode: input.contentError.code,
      userMessageId: input.prepared.userMessage.id,
      sourceUserMessageId: input.prepared.userMessage.id,
      traceId:
        input.prepared.traceContext?.traceId ?? input.prepared.userMessage.id,
      modelAlias: input.prepared.modelAlias,
      profileAlias: input.prepared.profileAlias,
      agentMode: input.prepared.agentMode,
      versionOf: input.prepared.assistantMessageParentId,
      billingSkipped: true,
      billingSkipReason: "model_error",
    },
  });
}
