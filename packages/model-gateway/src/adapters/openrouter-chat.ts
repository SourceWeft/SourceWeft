import { ChatOpenAI } from "@langchain/openai";
import type { ChatAdapter } from "./types";
import { resolveThinkingMode } from "../thinking";

function buildOpenRouterReasoningModelKwargs(
  input: Parameters<ChatAdapter["createModel"]>[1],
) {
  const thinking = input.thinking;
  if (!thinking) {
    return {};
  }

  const supportedParameters = new Set(
    (thinking?.supportedParameters ?? []).map((parameter) =>
      parameter.trim().toLowerCase()
    ),
  );
  const supportedEfforts = new Set(thinking.supportedEfforts ?? []);

  const mode = resolveThinkingMode(thinking);
  if (mode === "auto") {
    return {};
  }

  if (mode === "off") {
    if (supportedParameters.has("reasoning")) {
      return {
        reasoning: {
          exclude: true,
        },
      };
    }

    return supportedParameters.has("include_reasoning")
      ? { include_reasoning: false }
      : {};
  }

  const effort = thinking.effort ?? "medium";
  if (!supportedEfforts.has(effort)) {
    return {};
  }

  if (supportedParameters.has("reasoning")) {
    return {
      ...(thinking.includeReasoning === true && supportedParameters.has("include_reasoning")
        ? { include_reasoning: true }
        : {}),
      reasoning: {
        enabled: true,
        effort,
        exclude: thinking.includeReasoning !== true,
      },
    };
  }

  if (supportedParameters.has("reasoning_effort")) {
    return {
      ...(thinking.includeReasoning === true && supportedParameters.has("include_reasoning")
        ? { include_reasoning: true }
        : {}),
      reasoning_effort: effort,
    };
  }

  return {};
}

export class OpenRouterChatAdapter implements ChatAdapter {
  readonly kind = "openrouter" as const;

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
        baseURL: target.baseUrl,
        defaultHeaders: target.defaultHeaders,
      },
      modelKwargs: {
        ...(input.extraBody ?? {}),
        ...buildOpenRouterReasoningModelKwargs(input),
      },
      __includeRawResponse: true,
      maxTokens: input.maxTokens,
      streaming: input.stream ?? false,
    });
  }
}
