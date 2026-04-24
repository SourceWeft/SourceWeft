import type { UsageInfo } from "../types";
import { isRecord } from "../utils/object";

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readDetailsValue(details: unknown, key: string): number | undefined {
  if (!isRecord(details)) {
    return undefined;
  }
  return asNumber(details[key]);
}

export function normalizeUsage(input: unknown): UsageInfo | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const promptTokens =
    asNumber(input.prompt_tokens) ?? asNumber(input.input_tokens);
  const completionTokens =
    asNumber(input.completion_tokens) ?? asNumber(input.output_tokens);
  const totalTokens = asNumber(input.total_tokens);

  const promptDetails =
    input.prompt_tokens_details ?? input.input_tokens_details;

  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens,
    cacheReadTokens: readDetailsValue(promptDetails, "cached_tokens"),
    cacheWriteTokens: readDetailsValue(promptDetails, "cache_creation_tokens"),
  };
}
