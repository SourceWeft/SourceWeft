import {
  recordGatewayOperationEvent,
  type LlmExecutionConfig,
} from "../../model-gateway-audit";
import type { ContentError } from "../../errors";
import { deleteMessageRecord } from "../message-repository";
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
    profileAlias: input.prepared.profileAlias,
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
