import { getModelGatewayClient } from "../../../../shared/model-gateway/index";
import { logger } from "../../../../shared/logger";
import { buildChatTitlePrompt } from "../../agent/prompts";
import {
  buildGatewayRequestMetadata,
  type LlmExecutionConfig,
} from "../../model-gateway-audit";
import { updateThreadTitleIfMatches } from "./repository";
import {
  normalizeChatTitle,
  normalizeGeneratedChatTitle,
  resolveAssistantContent,
} from "./title";

export type GenerateThreadTitleInput = {
  teamId: string;
  workspaceId: string;
  threadId: string;
  traceId?: string;
  userId: string;
  userMessageId: string;
  messageContent: string;
  profileAlias: string;
  modelAlias: string;
  gatewayConfigId: string;
  llm?: LlmExecutionConfig;
  parentSpanId?: string | null;
};

export type ApplyGeneratedThreadTitleInput = GenerateThreadTitleInput & {
  expectedTitle: string;
  title: string;
};

export function buildFallbackThreadTitle(messageContent: string) {
  const normalized = messageContent
    .replace(/[`*_#>\[\](){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalizeChatTitle(normalized, "New conversation");
}

export async function generateThreadTitle(input: GenerateThreadTitleInput) {
  const gateway = await getModelGatewayClient(input.gatewayConfigId);
  const completion = await gateway.chat.complete(
    {
      model: input.profileAlias,
      messages: [
        {
          role: "user",
          content: buildChatTitlePrompt(input.messageContent),
        },
      ],
      metadata: {
        team_id: input.teamId,
        workspace_id: input.workspaceId,
        user_id: input.userId,
        thread_id: input.threadId,
        feature: "chat",
      },
      executionMode: input.llm?.executionMode,
      providerHint: input.llm?.providerHint,
      byok: input.llm?.byok,
    },
    {
      idempotencyKey: `thread-title:${input.userMessageId}`,
      traceId: input.traceId ?? input.userMessageId,
      metadata: buildGatewayRequestMetadata({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        threadId: input.threadId,
        messageId: input.userMessageId,
        feature: "chat",
        operation: "chat.title",
        modelAlias: input.modelAlias,
        profileAlias: input.profileAlias,
        llm: input.llm,
        parentSpanId: input.parentSpanId,
      }),
    },
  );

  const title = normalizeGeneratedChatTitle(
    resolveAssistantContent({ raw: completion.raw }),
  );
  logger.debug("Generated automatic thread title candidate", {
    threadId: input.threadId,
    userMessageId: input.userMessageId,
    modelAlias: input.modelAlias,
    hasGeneratedTitle: Boolean(title),
  });
  return title;
}

export async function applyGeneratedThreadTitle(
  input: ApplyGeneratedThreadTitleInput,
) {
  const title = normalizeGeneratedChatTitle(input.title);
  if (!title || title === input.expectedTitle) {
    return null;
  }

  return updateThreadTitleIfMatches({
    threadId: input.threadId,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    expectedTitles: [input.expectedTitle],
    title,
  });
}
