import { sdkRetryOptions } from "./gateway-caller";
import { ChatDeepSeek } from "@langchain/deepseek";
import { ModelGatewayError } from "../errors";
import { resolveThinkingMode } from "../thinking";
import type { ChatCompleteInput, ReasoningEffort } from "../types";
import type { ChatAdapter } from "./types";
import { captureProviderResponseFetch } from "../observation/response-capture";

/**
 * DeepSeek's effort scale is only "high" | "max", so the shared five-value
 * scale has to be projected onto it. Efforts below "high" deliberately have no
 * entry: sending "high" for a "low" request would quietly buy — and bill —
 * more reasoning than was asked for, so they fall through to DeepSeek's own
 * default instead.
 */
const DEEPSEEK_EFFORT: Partial<Record<ReasoningEffort, "high" | "max">> = {
  high: "high",
  xhigh: "max",
};

/**
 * DeepSeek enables thinking server-side by default, so "off" is the case that
 * has to be stated explicitly rather than the case that can be omitted.
 *
 * buildOpenAIReasoningModelKwargs is not reusable here: it speaks OpenRouter's
 * `reasoning: {enabled, effort, exclude}` shape, which DeepSeek rejects, and it
 * expresses "off" by asking the provider to hide reasoning rather than to stop
 * producing it.
 */
function buildDeepSeekThinkingKwargs(input: ChatCompleteInput) {
  const mode = resolveThinkingMode(input.thinking);

  if (mode === "auto") {
    return {};
  }
  if (mode === "off") {
    return { thinking: { type: "disabled" } };
  }

  const effort = input.thinking?.effort
    ? DEEPSEEK_EFFORT[input.thinking.effort]
    : undefined;

  return {
    thinking: { type: "enabled" },
    ...(effort ? { reasoning_effort: effort } : {}),
  };
}

/**
 * Chat adapter for DeepSeek's first-party API.
 *
 * `ChatDeepSeek` carries the provider quirks this adapter would otherwise have
 * to hand-roll: it pins structured output to `functionCalling` (DeepSeek only
 * accepts `response_format: {type:"json_object"}`, which does not carry the
 * schema at all), it lifts `<think>` blocks out of the stream into
 * `reasoning_content` including the case where a tag straddles two chunks, and
 * it extends ChatOpenAICompletions so it never attempts the Responses API.
 */
export class DeepSeekChatAdapter implements ChatAdapter {
  readonly kind = "deepseek" as const;

  createModel(
    target: Parameters<ChatAdapter["createModel"]>[0],
    input: Parameters<ChatAdapter["createModel"]>[1],
    options?: Parameters<ChatAdapter["createModel"]>[2],
  ) {
    // ChatDeepSeek's constructor throws a bare Error on a missing key, which
    // would reach the worker unclassified instead of as a gateway error.
    if (!target.apiKey) {
      throw new ModelGatewayError({
        code: "BAD_REQUEST",
        message: "DeepSeek provider requires an API key",
        retryable: false,
        provider: target.provider,
      });
    }

    return new ChatDeepSeek({
      model: target.providerModel,
      temperature: input.temperature,
      topP: input.topP,
      ...sdkRetryOptions(options),
      timeout: options?.timeoutMs,
      apiKey: target.apiKey,
      configuration: {
        ignoreEnvironmentHeaders: true,
        baseURL: target.baseUrl,
        defaultHeaders: target.defaultHeaders,
        fetch: captureProviderResponseFetch(options?.fetch),
        adminAPIKey: null,
      },
      modelKwargs: {
        ...(input.extraBody ?? {}),
        ...buildDeepSeekThinkingKwargs(input),
      },
      __includeRawResponse: true,
      maxTokens: input.maxTokens,
      streaming: input.stream ?? false,
    });
  }
}
