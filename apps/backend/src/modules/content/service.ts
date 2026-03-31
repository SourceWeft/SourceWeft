import { LiteLLMError, type UsageInfo } from "@sourceweft/litellm-sdk";
import {
  createMessageRecord,
  createSourceRecord,
  createThreadRecord,
  findSourceRecord,
  findThreadRecord,
  markSourceIndexed,
} from "./store";
import { ContentError } from "./errors";
import { workspaceService } from "../workspace";
import { billingService } from "../billing";
import { config } from "../../shared/config";
import { litellm } from "../../shared/litellm";

const DEFAULT_MODEL_ALIAS = "chat-default";

function normalizeTitle(value: string | undefined, fallback: string) {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, 200);
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateProviderCostUsd(input: {
  userContent: string;
  assistantContent: string;
  usage?: UsageInfo;
}) {
  const usage = input.usage;
  const inputTokens = usage?.inputTokens ?? estimateTokens(input.userContent);
  const outputTokens =
    usage?.outputTokens ?? estimateTokens(input.assistantContent);
  const totalTokens = usage?.totalTokens ?? inputTokens + outputTokens;

  const usd = totalTokens * 0.000002;
  return Number(usd.toFixed(6));
}

function toContentServiceError(error: unknown): ContentError {
  if (!LiteLLMError.isInstance(error)) {
    return new ContentError(502, "MODEL_UPSTREAM_ERROR", "LLM request failed");
  }

  const litellmError = error as LiteLLMError;

  if (litellmError.code === "BAD_REQUEST") {
    return new ContentError(400, "MODEL_REQUEST_INVALID", litellmError.message);
  }

  if (litellmError.code === "RATE_LIMIT") {
    return new ContentError(
      429,
      "MODEL_RATE_LIMITED",
      "LLM provider rate limit reached",
    );
  }

  if (litellmError.code === "TIMEOUT") {
    return new ContentError(504, "MODEL_TIMEOUT", "LLM request timed out");
  }

  if (litellmError.code === "AUTH") {
    return new ContentError(
      502,
      "MODEL_GATEWAY_AUTH_ERROR",
      "LiteLLM gateway authentication failed",
    );
  }

  return new ContentError(502, "MODEL_UPSTREAM_ERROR", litellmError.message);
}

function resolveAssistantContent(input: {
  outputText: string;
  toolCalls?: Array<{ name: string; argsJson?: string }>;
}) {
  const text = input.outputText.trim();
  if (text.length > 0) {
    return text;
  }

  if (input.toolCalls && input.toolCalls.length > 0) {
    return input.toolCalls
      .map((toolCall) => `${toolCall.name}: ${toolCall.argsJson ?? "{}"}`)
      .join("\n");
  }

  return "Model returned an empty response.";
}

export class ContentService {
  async createSource(input: {
    workspaceId: string;
    userId: string;
    title?: string;
    contentText?: string;
    estimatedPages?: number;
    parsedTokens?: number;
  }) {
    const workspace = await workspaceService.resolveWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    if (!workspace) {
      throw new ContentError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
    }

    const source = await createSourceRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      title: normalizeTitle(input.title, "Untitled Source"),
      contentText: input.contentText ?? "",
      createdBy: input.userId,
      estimatedPages: input.estimatedPages,
      parsedTokens: input.parsedTokens,
    });

    return { source };
  }

  async indexSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
    estimatedPages?: number;
    parsedTokens?: number;
    idempotencyKey?: string;
  }) {
    const workspace = await workspaceService.resolveWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    if (!workspace) {
      throw new ContentError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
    }

    const source = await findSourceRecord({
      sourceId: input.sourceId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });

    if (!source) {
      throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
    }

    const billing = await billingService.meterIngestion(
      workspace.organizationId,
      {
        workspaceId: workspace.id,
        feature: "ingestion",
        referenceId: `source:${source.id}`,
        idempotencyKey: input.idempotencyKey || `source-index:${source.id}`,
        pages: input.estimatedPages,
        parsedTokens: input.parsedTokens,
      },
      input.userId,
    );

    const updatedSource = await markSourceIndexed({
      sourceId: source.id,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      estimatedPages: input.estimatedPages ?? source.estimatedPages,
      parsedTokens: input.parsedTokens ?? source.parsedTokens,
    });

    return {
      source: updatedSource,
      billing,
    };
  }

  async createThread(input: {
    workspaceId: string;
    userId: string;
    title?: string;
  }) {
    const workspace = await workspaceService.resolveWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    if (!workspace) {
      throw new ContentError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
    }

    const thread = await createThreadRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      title: normalizeTitle(input.title, "New Thread"),
      createdBy: input.userId,
    });

    return { thread };
  }

  async streamThread(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    content: string;
    idempotencyKey?: string;
  }) {
    const messageContent = input.content.trim();
    if (!messageContent) {
      throw new ContentError(
        400,
        "EMPTY_MESSAGE",
        "content is required for thread stream",
      );
    }

    const workspace = await workspaceService.resolveWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    if (!workspace) {
      throw new ContentError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
    }

    const thread = await findThreadRecord({
      threadId: input.threadId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });

    if (!thread) {
      throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
    }

    const userMessage = await createMessageRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
      role: "user",
      content: messageContent,
      createdBy: input.userId,
      metadata: {
        source: "api",
      },
    });

    const modelAlias = config.litellm.chatModelAlias || DEFAULT_MODEL_ALIAS;

    const llmIdempotencyKey =
      input.idempotencyKey || `thread-stream:${userMessage.id}:assistant`;

    const completion = await litellm.chat
      .complete(
        {
          model: modelAlias,
          messages: [
            {
              role: "user",
              content: messageContent,
            },
          ],
          metadata: {
            team_id: workspace.organizationId,
            workspace_id: workspace.id,
            user_id: input.userId,
            thread_id: thread.id,
            feature: "chat",
          },
        },
        {
          idempotencyKey: llmIdempotencyKey,
          traceId: userMessage.id,
        },
      )
      .catch((error: unknown) => {
        throw toContentServiceError(error);
      });

    const assistantContent = resolveAssistantContent({
      outputText: completion.outputText,
      toolCalls: completion.message.toolCalls?.map(
        (toolCall: { name: string; argsJson?: string }) => ({
          name: toolCall.name,
          argsJson: toolCall.argsJson,
        }),
      ),
    });

    const providerCostUsd = estimateProviderCostUsd({
      userContent: messageContent,
      assistantContent,
      usage: completion.usage,
    });

    const billing = await billingService.meterConsume(
      workspace.organizationId,
      {
        workspaceId: workspace.id,
        feature: "chat",
        referenceId: `thread:${thread.id}:message:${userMessage.id}`,
        idempotencyKey: llmIdempotencyKey,
        providerCostUsd,
        platformCostUsd: 0.00005,
      },
      input.userId,
    );

    const assistantMessage = await createMessageRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
      role: "assistant",
      content: assistantContent,
      createdBy: null,
      model: completion.model || modelAlias,
      creditsConsumed: billing.consumedCredits,
      metadata: {
        providerCostUsd,
        modelAlias,
        finishReason: completion.finishReason,
        usage: completion.usage,
        reasoning: completion.reasoning,
        providerFields: completion.providerFields,
      },
    });

    return {
      thread,
      userMessage,
      assistantMessage,
      billing,
    };
  }
}

export const contentService = new ContentService();
