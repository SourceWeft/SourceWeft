import type { ChatCompleteInput } from "../types";
import { resolveThinkingMode } from "../thinking";

export function buildOpenAIReasoningModelKwargs(input: ChatCompleteInput) {
  const thinking = input.thinking;
  if (!thinking) {
    return {};
  }

  const supportedParameters = new Set(
    (thinking.supportedParameters ?? []).map((parameter) =>
      parameter.trim().toLowerCase(),
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
      ...(thinking.includeReasoning === true &&
      supportedParameters.has("include_reasoning")
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
      ...(thinking.includeReasoning === true &&
      supportedParameters.has("include_reasoning")
        ? { include_reasoning: true }
        : {}),
      reasoning_effort: effort,
    };
  }

  return {};
}
