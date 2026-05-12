import {
  recordGatewayOperationEvent,
  type LlmExecutionConfig,
} from "../../model-gateway-audit";
import type { AgentCitation } from "../../agent/citation-registry";
import type { ContentError } from "../../errors";
import { logger } from "../../../../shared/logger";
import {
  createMessageRecord,
  deleteMessageRecord,
} from "../message-repository";
import { summarizeRetrievalCalls } from "../turn/service";
import type {
  MessageRenderBlock,
  ModelReasoningSegmentTrace,
  PreparedThreadTurn,
  ThinkingStepTrace,
  ToolCallTrace,
} from "../turn/types";

export type ThreadStreamPartialErrorState = {
  reasoning?: string;
  reasoningSegments?: ModelReasoningSegmentTrace[];
  toolCalls?: ToolCallTrace[];
  thinkingSteps?: ThinkingStepTrace[];
  renderBlocks?: MessageRenderBlock[];
  citations?: AgentCitation[];
  availableCitations?: AgentCitation[];
};

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
  partialState?: ThreadStreamPartialErrorState;
}) {
  if (input.prepared.failurePersistence !== "persist-error-turn") {
    return null;
  }

  const assistantContent =
    input.partialAssistantContent === undefined
      ? input.contentError.message
      : input.partialAssistantContent.trimEnd();
  const preflightCreditsConsumed = input.prepared.preflightBilling.reduce(
    (sum, item) => sum + item.consumedCredits,
    0,
  );

  return createMessageRecord({
    teamId: input.prepared.workspace.organizationId,
    workspaceId: input.prepared.workspace.id,
    threadId: input.prepared.thread.id,
    parentMessageId: input.prepared.assistantMessageParentId,
    role: "assistant",
    content: assistantContent,
    createdBy: null,
    model: input.prepared.modelAlias,
    creditsConsumed: preflightCreditsConsumed,
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
      preflightBilling: input.prepared.preflightBilling,
      preflightCreditsConsumed,
      reasoning: input.partialState?.reasoning,
      reasoningSegments: input.partialState?.reasoningSegments,
      toolCalls: input.partialState?.toolCalls,
      renderBlocks: input.partialState?.renderBlocks,
      thinkingSteps: input.partialState?.thinkingSteps,
      retrieval: {
        citations: input.partialState?.citations ?? [],
        availableCitations:
          input.partialState?.availableCitations ??
          input.partialState?.citations ??
          [],
      },
    },
  });
}
