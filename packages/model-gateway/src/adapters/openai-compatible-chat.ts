import { ChatOpenAI } from "@langchain/openai";
import type { ChatAdapter } from "./types";

export class OpenAICompatibleChatAdapter implements ChatAdapter {
  readonly kind = "openai-compatible" as const;

  createModel(target: Parameters<ChatAdapter["createModel"]>[0], input: Parameters<ChatAdapter["createModel"]>[1]) {
    return new ChatOpenAI({
      model: target.providerModel,
      temperature: input.temperature,
      topP: input.topP,
      maxRetries: 2,
      apiKey: target.apiKey,
      configuration: {
        baseURL: target.baseUrl,
        defaultHeaders: target.defaultHeaders,
      },
      maxTokens: input.maxTokens,
      streaming: input.stream ?? false,
    });
  }
}
