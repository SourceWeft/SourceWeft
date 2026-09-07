import { sdkRetryOptions } from "./gateway-caller";
import { ChatAnthropic } from "@langchain/anthropic";
import type { ChatAdapter } from "./types";

export class AnthropicChatAdapter implements ChatAdapter {
  readonly kind = "anthropic" as const;

  createModel(
    target: Parameters<ChatAdapter["createModel"]>[0],
    input: Parameters<ChatAdapter["createModel"]>[1],
    options?: Parameters<ChatAdapter["createModel"]>[2],
  ) {
    return new ChatAnthropic({
      model: target.providerModel,
      temperature: input.temperature,
      topP: input.topP,
      ...sdkRetryOptions(options),
      apiKey: target.apiKey,
      anthropicApiUrl: target.baseUrl,
      clientOptions: {
        timeout: options?.timeoutMs,
        fetch: options?.fetch,
        authToken: null,
        defaultHeaders: target.defaultHeaders,
      },
      maxTokens: input.maxTokens,
      streaming: input.stream ?? false,
    });
  }
}
