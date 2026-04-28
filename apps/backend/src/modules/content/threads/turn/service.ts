import { getModelGatewayClient } from "../../../../shared/model-gateway/index";
import { buildChatTitlePrompt } from "../../agent/prompts";
import {
  buildGatewayRequestMetadata,
  type LlmExecutionConfig,
} from "../../model-gateway-audit";
import type { ContentBillingPort } from "../../billing-port";
import { updateThreadTitleIfMatches } from "../thread/repository";
import {
  buildAutomaticTitleCandidates,
  normalizeGeneratedChatTitle,
  resolveAssistantContent,
} from "../thread/title";
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
  RetrievalCallTrace,
  StreamThreadEventInput,
  ThinkingStepTrace,
  ToolCallStatus,
  ToolCallTrace,
} from "./types";
export { summarizeRetrievalCalls } from "./retrieval-summary";

class ContentThreadTurnService {
  constructor(private readonly billing: ContentBillingPort) {}

  async prepareThreadTurn(input: StreamThreadEventInput): Promise<PreparedThreadTurn> {
    return prepareThreadTurn(input);
  }

  async generateChatTitle(input: {
    prepared: PreparedThreadTurn;
    llm?: LlmExecutionConfig;
  }) {
    try {
      const gateway = await getModelGatewayClient(input.prepared.chatProfile.gatewayConfigId);
      const completion = await gateway.chat.complete(
        {
          model: input.prepared.modelAlias,
          messages: [
            {
              role: "user",
              content: buildChatTitlePrompt(input.prepared.messageContent),
            },
          ],
          metadata: {
            team_id: input.prepared.workspace.organizationId,
            workspace_id: input.prepared.workspace.id,
            user_id: input.prepared.userId,
            thread_id: input.prepared.thread.id,
            feature: "chat",
          },
          executionMode: input.llm?.executionMode,
          providerHint: input.llm?.providerHint,
          byok: input.llm?.byok,
        },
        {
          idempotencyKey: `thread-title:${input.prepared.userMessage.id}`,
          traceId: input.prepared.userMessage.id,
          metadata: buildGatewayRequestMetadata({
            teamId: input.prepared.workspace.organizationId,
            workspaceId: input.prepared.workspace.id,
            userId: input.prepared.userId,
            threadId: input.prepared.thread.id,
            messageId: input.prepared.userMessage.id,
            feature: "chat",
            operation: "chat.title",
            modelAlias: input.prepared.modelAlias,
            llm: input.llm,
          }),
        },
      );

      return normalizeGeneratedChatTitle(resolveAssistantContent({ raw: completion.raw }));
    } catch {
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

    return updateThreadTitleIfMatches({
      threadId: input.prepared.thread.id,
      teamId: input.prepared.workspace.organizationId,
      workspaceId: input.prepared.workspace.id,
      expectedTitles: buildAutomaticTitleCandidates({
        currentTitle: input.expectedTitle,
        firstMessageTitle: input.prepared.firstMessageTitle,
      }),
      title,
    });
  }
}

export { ContentThreadTurnService };
