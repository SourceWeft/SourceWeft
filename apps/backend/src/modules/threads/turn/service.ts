import { logger } from "../../../shared/logger";
import type { LlmExecutionConfig } from "../../content/model-gateway-audit";
import type { ContentBillingPort } from "../../content/billing-port";
import {
  applyGeneratedThreadTitle,
  generateThreadTitle,
} from "../thread/title-generation";
import { normalizeGeneratedChatTitle } from "../thread/title";
import { finalizeThreadTurn } from "./finalizer";
import { prepareThreadTurn } from "./preparer";
import type {
  FinalizeThreadTurnCommand,
  PreparedThreadTurn,
  StreamThreadEventInput,
} from "./types";

export {
  isPlaceholderThreadTitle,
  normalizeGeneratedChatTitle,
} from "../thread/title";
export type {
  PreparedThreadTurn,
  MeteredLlmCallTrace,
  RetrievalCallTrace,
  StreamThreadEventInput,
  ThreadToolsSelection,
  ThinkingStepTrace,
  ToolCallStatus,
  ToolCallTrace,
} from "./types";
export { summarizeRetrievalCalls } from "./retrieval-summary";

class ContentThreadTurnService {
  constructor(private readonly billing: ContentBillingPort) {}

  async prepareThreadTurn(
    input: StreamThreadEventInput,
  ): Promise<PreparedThreadTurn> {
    return prepareThreadTurn(input, { billing: this.billing });
  }

  async generateChatTitle(input: {
    prepared: PreparedThreadTurn;
    llm?: LlmExecutionConfig;
  }) {
    try {
      return await generateThreadTitle({
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
        llm: input.llm,
        parentSpanId: input.prepared.traceContext?.parentSpanId,
        billing: this.billing,
      });
    } catch (error) {
      logger.debug("Automatic thread title generation failed", {
        threadId: input.prepared.thread.id,
        userMessageId: input.prepared.userMessage.id,
        modelAlias: input.prepared.modelAlias,
        gatewayConfigId: input.prepared.chatProfile.gatewayConfigId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async finalizeThreadTurn(input: FinalizeThreadTurnCommand) {
    return finalizeThreadTurn({ ...input, billing: this.billing });
  }

  async applyAutomaticThreadTitle(input: {
    prepared: PreparedThreadTurn;
    title: string;
    expectedTitle: string;
  }) {
    const title = normalizeGeneratedChatTitle(input.title);
    if (!title || title === input.expectedTitle) {
      return null;
    }

    return applyGeneratedThreadTitle({
      teamId: input.prepared.workspace.organizationId,
      workspaceId: input.prepared.workspace.id,
      threadId: input.prepared.thread.id,
      userId: input.prepared.userId,
      userMessageId: input.prepared.userMessage.id,
      messageContent: input.prepared.messageContent,
      profileAlias: input.prepared.profileAlias,
      modelAlias: input.prepared.modelAlias,
      providerModel: input.prepared.providerModel,
      gatewayConfigId: input.prepared.chatProfile.gatewayConfigId,
      expectedTitle: input.expectedTitle,
      title,
    });
  }
}

export { ContentThreadTurnService };
