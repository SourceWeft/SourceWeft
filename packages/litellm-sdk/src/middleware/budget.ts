import { LiteLLMError } from "../errors";
import type { UsageInfo } from "../types";

export interface BudgetPolicy {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
}

export function enforceUsageBudget(
  usage: UsageInfo | undefined,
  policy: BudgetPolicy | undefined,
) {
  if (!usage || !policy) {
    return;
  }

  if (
    policy.maxInputTokens !== undefined &&
    usage.inputTokens !== undefined &&
    usage.inputTokens > policy.maxInputTokens
  ) {
    throw new LiteLLMError({
      code: "BAD_REQUEST",
      message: `Input token budget exceeded (${usage.inputTokens} > ${policy.maxInputTokens})`,
      retryable: false,
    });
  }

  if (
    policy.maxOutputTokens !== undefined &&
    usage.outputTokens !== undefined &&
    usage.outputTokens > policy.maxOutputTokens
  ) {
    throw new LiteLLMError({
      code: "BAD_REQUEST",
      message: `Output token budget exceeded (${usage.outputTokens} > ${policy.maxOutputTokens})`,
      retryable: false,
    });
  }

  if (
    policy.maxTotalTokens !== undefined &&
    usage.totalTokens !== undefined &&
    usage.totalTokens > policy.maxTotalTokens
  ) {
    throw new LiteLLMError({
      code: "BAD_REQUEST",
      message: `Total token budget exceeded (${usage.totalTokens} > ${policy.maxTotalTokens})`,
      retryable: false,
    });
  }
}
