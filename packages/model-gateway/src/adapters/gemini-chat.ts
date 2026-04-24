import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { ChatAdapter } from "./types";

export class GeminiChatAdapter implements ChatAdapter {
  readonly kind = "gemini" as const;

  createModel(target: Parameters<ChatAdapter["createModel"]>[0], input: Parameters<ChatAdapter["createModel"]>[1]) {
    return new ChatGoogleGenerativeAI({
      model: target.providerModel,
      temperature: input.temperature,
      topP: input.topP,
      maxOutputTokens: input.maxTokens,
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      streaming: input.stream ?? false,
    });
  }
}
