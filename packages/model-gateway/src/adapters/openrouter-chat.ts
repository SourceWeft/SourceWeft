import { ChatOpenAI } from "@langchain/openai";
import type { ChatAdapter } from "./types";
import type { ProviderRoutingConfig } from "../types";
import { buildOpenAIReasoningModelKwargs } from "./openai-reasoning";

function mergeOpenRouterProviderRouting(
  extraBody: Record<string, unknown> | undefined,
  providerRouting: ProviderRoutingConfig | undefined,
): Record<string, unknown> | undefined {
  if (!providerRouting) {
    return extraBody;
  }

  const existingProvider =
    extraBody?.provider && typeof extraBody.provider === "object" && !Array.isArray(extraBody.provider)
      ? (extraBody.provider as Record<string, unknown>)
      : {};

  return {
    ...(extraBody ?? {}),
    provider: {
      ...existingProvider,
      ...(providerRouting.only ? { only: providerRouting.only } : {}),
      ...(providerRouting.sort ? { sort: providerRouting.sort } : {}),
    },
  };
}

export class OpenRouterChatAdapter implements ChatAdapter {
  readonly kind = "openrouter" as const;

  createModel(
    target: Parameters<ChatAdapter["createModel"]>[0],
    input: Parameters<ChatAdapter["createModel"]>[1],
    options?: Parameters<ChatAdapter["createModel"]>[2],
  ) {
    return new ChatOpenAI({
      model: target.providerModel,
      temperature: input.temperature,
      topP: input.topP,
      maxRetries: options?.maxRetries ?? 2,
      timeout: options?.timeoutMs,
      apiKey: target.apiKey,
      configuration: {
        baseURL: target.baseUrl,
        defaultHeaders: target.defaultHeaders,
      },
      modelKwargs: {
        ...(mergeOpenRouterProviderRouting(
          input.extraBody,
          target.providerRouting,
        ) ?? {}),
        ...buildOpenAIReasoningModelKwargs(input),
      },
      __includeRawResponse: true,
      maxTokens: input.maxTokens,
      streaming: input.stream ?? false,
    });
  }
}
