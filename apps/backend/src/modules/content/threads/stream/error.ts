import { createMessageRecord } from "../message-repository";
import {
  buildGatewayAuditMetadata,
  recordGatewayOperationEvent,
  type LlmExecutionConfig,
} from "../../model-gateway-audit";
import type { ContentError } from "../../errors";
import { summarizeRetrievalCalls } from "../turn/service";
import type { PreparedThreadTurn } from "../turn/service";

export async function recordThreadStreamFailure(input: {
  prepared: PreparedThreadTurn;
  contentError: ContentError;
  operation: "chat.stream" | "chat.complete";
  llm?: LlmExecutionConfig;
}) {
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
    llm: input.llm,
    traceId: input.prepared.userMessage.id,
    success: false,
    errorCode: input.contentError.code,
    errorMessage: input.contentError.message,
    attributes: {
      retrievalCalls: summarizeRetrievalCalls([]),
    },
  });
}

export async function createErrorAssistantMessage(input: {
  prepared: PreparedThreadTurn;
  contentError: ContentError;
  llm?: LlmExecutionConfig;
}) {
  return createMessageRecord({
    teamId: input.prepared.workspace.organizationId,
    workspaceId: input.prepared.workspace.id,
    threadId: input.prepared.thread.id,
    parentMessageId: input.prepared.assistantMessageParentId,
    role: "assistant",
    content: input.contentError.message,
    createdBy: null,
    model: input.prepared.modelAlias,
    metadata: {
      status: "error",
      isError: true,
      excludeFromContext: true,
      errorCode: input.contentError.code,
      errorMessage: input.contentError.message,
      userMessageId: input.prepared.userMessage.id,
      sourceAssistantMessageId: input.prepared.assistantMessageParentId,
      versionOf: input.prepared.assistantMessageParentId,
      modelAlias: input.prepared.modelAlias,
      gateway: buildGatewayAuditMetadata({ llm: input.llm }),
    },
  });
}
