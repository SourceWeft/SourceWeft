import { ChatOpenAI } from "@langchain/openai";
import type { ChatAdapter } from "./types";
import { captureProviderResponseFetch } from "../observation/response-capture";

function resolveOpenAICompatibleBaseUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, "")}/openai`;
}

export class DeepInfraChatAdapter implements ChatAdapter {
  readonly kind = "deepinfra" as const;

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
      apiKey: target.apiKey,
      configuration: {
        baseURL: resolveOpenAICompatibleBaseUrl(target.baseUrl),
        defaultHeaders: target.defaultHeaders,
        fetch: captureProviderResponseFetch(),
      },
      __includeRawResponse: true,
      maxTokens: input.maxTokens,
      streaming: input.stream ?? false,
    });
  }
}
