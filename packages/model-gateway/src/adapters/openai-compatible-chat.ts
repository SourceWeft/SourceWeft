import { sdkRetryOptions } from "./gateway-caller";
import { ChatOpenAI } from "@langchain/openai";
import {
  buildOpenAICompatibleDefaultHeaders,
  unauthenticatedOpenAIConfiguration,
} from "../auth-headers";
import { buildOpenAIReasoningModelKwargs } from "./openai-reasoning";
import { captureProviderResponseFetch } from "../observation/response-capture";
import type { ChatAdapter } from "./types";

export class OpenAICompatibleChatAdapter implements ChatAdapter {
  readonly kind: ChatAdapter["kind"] = "openai-compatible";

  createModel(
    target: Parameters<ChatAdapter["createModel"]>[0],
    input: Parameters<ChatAdapter["createModel"]>[1],
    options?: Parameters<ChatAdapter["createModel"]>[2],
  ) {
    return new ChatOpenAI({
      model: target.providerModel,
      temperature: input.temperature,
      topP: input.topP,
      ...sdkRetryOptions(options),
      timeout: options?.timeoutMs,
      apiKey: target.apiKey,
      configuration: {
        ignoreEnvironmentHeaders: true,
        baseURL: target.baseUrl,
        defaultHeaders: buildOpenAICompatibleDefaultHeaders(target),
        fetch: captureProviderResponseFetch(options?.fetch),
        adminAPIKey: null,
        ...unauthenticatedOpenAIConfiguration(target),
      },
      modelKwargs: {
        ...(input.extraBody ?? {}),
        ...buildOpenAIReasoningModelKwargs(input),
      },
      __includeRawResponse: true,
      maxTokens: input.maxTokens,
      streaming: input.stream ?? false,
    });
  }
}
