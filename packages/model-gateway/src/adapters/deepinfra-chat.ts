import { ChatOpenAI } from "@langchain/openai";
import { resolveDeepInfraBaseUrls } from "./deepinfra-url";
import type { ChatAdapter } from "./types";

export class DeepInfraChatAdapter implements ChatAdapter {
  readonly kind = "deepinfra" as const;

  createModel(target: Parameters<ChatAdapter["createModel"]>[0], input: Parameters<ChatAdapter["createModel"]>[1]) {
    const { openAICompatibleBaseUrl } = resolveDeepInfraBaseUrls(target.baseUrl);

    return new ChatOpenAI({
      model: target.providerModel,
      temperature: input.temperature,
      topP: input.topP,
      maxRetries: 2,
      apiKey: target.apiKey,
      configuration: {
        baseURL: openAICompatibleBaseUrl,
        defaultHeaders: target.defaultHeaders,
      },
      maxTokens: input.maxTokens,
      streaming: input.stream ?? false,
    });
  }
}
