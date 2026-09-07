import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { ChatAdapter } from "./types";
import { GatewayCaller } from "./gateway-caller";

export class GeminiChatAdapter implements ChatAdapter {
  readonly kind = "gemini" as const;

  createModel(
    target: Parameters<ChatAdapter["createModel"]>[0],
    input: Parameters<ChatAdapter["createModel"]>[1],
    options?: Parameters<ChatAdapter["createModel"]>[2],
  ) {
    const model = new ChatGoogleGenerativeAI({
      model: target.providerModel,
      temperature: input.temperature,
      topP: input.topP,
      maxOutputTokens: input.maxTokens,
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      customHeaders: target.defaultHeaders,
      fetch: options?.fetch,
      streaming: input.stream ?? false,
    });
    model.caller = new GatewayCaller(options);
    return model;
  }
}
