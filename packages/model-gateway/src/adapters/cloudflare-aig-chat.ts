import { sdkRetryOptions } from "./gateway-caller";
import { ChatOpenAI } from "@langchain/openai";
import { buildOpenAICompatibleDefaultHeaders } from "../auth-headers";
import type { ChatAdapter } from "./types";
import { captureProviderResponseFetch } from "../observation/response-capture";

/**
 * Chat adapter for Cloudflare AI Gateway's OpenAI-compatible REST endpoint
 * (`.../ai/v1/chat/completions`).
 *
 * It is identical to {@link OpenAICompatibleChatAdapter} except that it never
 * forwards reasoning-control kwargs (`reasoning` / `reasoning_effort` /
 * `include_reasoning`). Cloudflare's compat schema rejects unknown fields, so
 * any `reasoning` param — with or without structured output — fails with
 * `400 "Extra inputs are not permitted, field: 'reasoning'"`. Upstream reasoning
 * models (e.g. deepseek-v4-pro) still reason server-side; the parameter only
 * controls whether reasoning tokens are surfaced, which this endpoint does not
 * support.
 */
export class CloudflareAIGChatAdapter implements ChatAdapter {
  readonly kind: ChatAdapter["kind"] = "cloudflare-aig";

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
      },
      modelKwargs: {
        ...(input.extraBody ?? {}),
      },
      __includeRawResponse: true,
      maxTokens: input.maxTokens,
      streaming: input.stream ?? false,
    });
  }
}
