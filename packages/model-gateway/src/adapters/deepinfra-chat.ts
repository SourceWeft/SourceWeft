import { sdkRetryOptions } from "./gateway-caller";
import { ChatOpenAI } from "@langchain/openai";
import type { ChatAdapter } from "./types";
import { captureProviderResponseFetch } from "../observation/response-capture";
import { resolveThinkingMode } from "../thinking";
import type { ChatCompleteInput } from "../types";

function resolveOpenAICompatibleBaseUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, "")}/openai`;
}

/**
 * DeepInfra's OpenAI-compatible endpoint controls reasoning with
 * `reasoning_effort`, and `"none"` switches it off. The default differs per
 * hosted model (DeepSeek V4.1 Flash answers without thinking, Qwen3, Kimi and
 * GLM think unless told otherwise), so "off" is stated instead of left to the
 * host. Only a profile that declares `reasoning_effort` gets the parameter.
 *
 * buildOpenAIReasoningModelKwargs is not reusable here: it has no portable
 * "off" for `reasoning_effort` and would send OpenRouter's `reasoning` object
 * for a profile that declares it.
 */
function buildDeepInfraReasoningKwargs(input: ChatCompleteInput) {
  const thinking = input.thinking;
  const declared = (thinking?.supportedParameters ?? []).some(
    (parameter) => parameter.trim().toLowerCase() === "reasoning_effort",
  );
  if (!thinking || !declared) {
    return {};
  }

  const mode = resolveThinkingMode(thinking);
  if (mode === "auto") {
    return {};
  }
  if (mode === "off") {
    return { reasoning_effort: "none" };
  }

  const effort = thinking.effort ?? "medium";
  return (thinking.supportedEfforts ?? []).includes(effort)
    ? { reasoning_effort: effort }
    : {};
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
      ...sdkRetryOptions(options),
      timeout: options?.timeoutMs,
      apiKey: target.apiKey,
      configuration: {
        ignoreEnvironmentHeaders: true,
        baseURL: resolveOpenAICompatibleBaseUrl(target.baseUrl),
        defaultHeaders: target.defaultHeaders,
        fetch: captureProviderResponseFetch(options?.fetch),
        adminAPIKey: null,
      },
      modelKwargs: buildDeepInfraReasoningKwargs(input),
      __includeRawResponse: true,
      maxTokens: input.maxTokens,
      streaming: input.stream ?? false,
    });
  }
}
