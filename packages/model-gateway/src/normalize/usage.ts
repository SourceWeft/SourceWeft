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

function readFirstNumber(
  record: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = asNumber(record[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function normalizeCostDetails(input: unknown): Record<string, number> | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const entries = Object.entries(input).flatMap(([key, value]) => {
    const normalized = asNumber(value);
    return normalized === undefined ? [] : [[key, normalized] as const];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function resolveProviderCost(input: Record<string, unknown>): Pick<
  UsageInfo,
  "providerCostUsd" | "providerCostSource" | "costDetails"
> {
  const costDetails = normalizeCostDetails(input.cost_details);
  const usageCost = asNumber(input.cost);
  if (usageCost !== undefined) {
    return {
      providerCostUsd: usageCost,
      providerCostSource: "usage.cost",
      costDetails,
    };
  }

  const upstreamInferenceCost =
    costDetails?.upstream_inference_cost ??
    costDetails?.upstream_cost ??
    costDetails?.inference_cost;
  if (upstreamInferenceCost !== undefined) {
    return {
      providerCostUsd: upstreamInferenceCost,
      providerCostSource: "usage.cost_details.upstream_inference_cost",
      costDetails,
    };
  }

  const estimatedCost = asNumber(input.estimated_cost);
  if (estimatedCost !== undefined) {
    return {
      providerCostUsd: estimatedCost,
      providerCostSource: "usage.estimated_cost",
      costDetails,
    };
  }

  return { costDetails };
}

function extractRawResponseUsage(input: unknown, depth = 0): unknown {
  if (depth > 8) {
    return undefined;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      const usage = extractRawResponseUsage(item, depth + 1);
      if (usage) {
        return usage;
      }
    }
    return undefined;
  }
  if (!isRecord(input)) {
    return undefined;
  }

  const rawResponse =
    (isRecord(input.__raw_response) ? input.__raw_response : undefined) ??
    (isRecord(input.raw_response) ? input.raw_response : undefined) ??
    (isRecord(input.rawResponse) ? input.rawResponse : undefined);
  if (rawResponse?.usage && isRecord(rawResponse.usage)) {
    return rawResponse.usage;
  }

  for (const key of [
    "__raw_response",
    "raw_response",
    "rawResponse",
    "additional_kwargs",
    "kwargs",
    "message",
    "choices",
    "delta",
  ]) {
    const usage = extractRawResponseUsage(input[key], depth + 1);
    if (usage) {
      return usage;
    }
  }

  return undefined;
}

export function normalizeUsage(input: unknown): UsageInfo | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const promptTokenBase =
    asNumber(input.prompt_tokens) ?? asNumber(input.input_tokens);
  const topLevelCacheReadTokens = asNumber(input.cache_read_input_tokens);
  const topLevelCacheWriteTokens = asNumber(input.cache_creation_input_tokens);
  const completionTokens =
    asNumber(input.completion_tokens) ?? asNumber(input.output_tokens);
  const totalTokens = asNumber(input.total_tokens);

  const promptDetails =
    input.prompt_tokens_details ??
    input.input_tokens_details ??
    input.input_token_details;
  const completionDetails =
    input.completion_tokens_details ??
    input.output_tokens_details ??
    input.output_token_details;

  const usage: UsageInfo = {
    inputTokens: promptTokenBase,
    outputTokens: completionTokens,
    totalTokens,
    cacheReadTokens:
      readDetailsValue(promptDetails, "cached_tokens") ??
      readDetailsValue(promptDetails, "cache_hit_tokens") ??
      readDetailsValue(promptDetails, "cache_read") ??
      asNumber(input.prompt_cache_hit_tokens) ??
      topLevelCacheReadTokens,
    cacheWriteTokens:
      readDetailsValue(promptDetails, "cache_write_tokens") ??
      readDetailsValue(promptDetails, "cache_creation_tokens") ??
      readDetailsValue(promptDetails, "cache_creation") ??
      topLevelCacheWriteTokens,
  };
  const optionalFields: UsageInfo = {
    reasoningTokens:
      readDetailsValue(completionDetails, "reasoning_tokens") ??
      readDetailsValue(completionDetails, "reasoning"),
    inputImageTokens:
      readDetailsValue(promptDetails, "image_tokens") ??
      readDetailsValue(promptDetails, "image"),
    outputImageTokens:
      readDetailsValue(completionDetails, "image_tokens") ??
      readDetailsValue(completionDetails, "image"),
    inputImageCount:
      readDetailsValue(promptDetails, "image_count") ??
      readDetailsValue(promptDetails, "images"),
    outputImageCount:
      readDetailsValue(completionDetails, "image_count") ??
      readDetailsValue(completionDetails, "images"),
    inputAudioTokens:
      readDetailsValue(promptDetails, "audio_tokens") ??
      readDetailsValue(promptDetails, "audio") ??
      asNumber(input.input_audio_tokens),
    outputAudioTokens:
      readDetailsValue(completionDetails, "audio_tokens") ??
      readDetailsValue(completionDetails, "audio") ??
      asNumber(input.output_audio_tokens),
    ...resolveProviderCost(input),
  };
  for (const [key, value] of Object.entries(optionalFields)) {
    if (value !== undefined) {
      (usage as Record<string, unknown>)[key] = value;
    }
  }

  return Object.values(usage).some((value) => value !== undefined)
    ? usage
    : undefined;
}

export function normalizeProviderUsage(input: unknown): UsageInfo | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const rawResponseUsage = extractRawResponseUsage(input);
  if (rawResponseUsage) {
    const normalized = normalizeUsage(rawResponseUsage);
    if (normalized) {
      return normalized;
    }
  }

  if (!("usage" in input) && !("inference_status" in input)) {
    return normalizeUsage(input);
  }

  const nestedUsage = normalizeUsage(input.usage);
  const inferenceStatus = isRecord(input.inference_status)
    ? input.inference_status
    : undefined;
  if (!inferenceStatus && !nestedUsage) {
    return undefined;
  }

  const inputTokens =
    nestedUsage?.inputTokens ??
    readFirstNumber(input, ["input_tokens", "prompt_tokens"]) ??
    (inferenceStatus
      ? readFirstNumber(inferenceStatus, ["tokens_input", "input_tokens"])
      : undefined);
  const outputTokens =
    nestedUsage?.outputTokens ??
    readFirstNumber(input, ["output_tokens", "completion_tokens"]) ??
    (inferenceStatus
      ? readFirstNumber(inferenceStatus, [
          "tokens_generated",
          "output_tokens",
          "completion_tokens",
        ])
      : undefined);
  const totalTokens =
    nestedUsage?.totalTokens ??
    readFirstNumber(input, ["total_tokens"]) ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  const inferenceCost = inferenceStatus
    ? asNumber(inferenceStatus.cost)
    : undefined;

  const usage: UsageInfo = {
    ...nestedUsage,
    inputTokens,
    outputTokens,
    totalTokens,
    ...(inferenceCost !== undefined
      ? {
          providerCostUsd: inferenceCost,
          providerCostSource: "inference_status.cost" as const,
        }
      : {}),
  };

  return Object.values(usage).some((value) => value !== undefined)
    ? usage
    : undefined;
}
