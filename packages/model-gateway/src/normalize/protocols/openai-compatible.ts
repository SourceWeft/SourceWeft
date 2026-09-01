import type { UsageInfo } from "../../types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function detailsNumber(
  details: unknown,
  ...keys: string[]
): number | undefined {
  if (!isRecord(details)) {
    return undefined;
  }
  for (const key of keys) {
    const value = finiteNumber(details[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function normalizeOpenAICompatibleUsage(
  input: unknown,
): UsageInfo | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const inputTokens =
    finiteNumber(input.prompt_tokens) ?? finiteNumber(input.input_tokens);
  const outputTokens =
    finiteNumber(input.completion_tokens) ?? finiteNumber(input.output_tokens);
  const reportedTotal = finiteNumber(input.total_tokens);
  const totalTokens =
    reportedTotal ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  const inputDetails =
    input.prompt_tokens_details ??
    input.input_tokens_details ??
    input.input_token_details;
  const outputDetails =
    input.completion_tokens_details ??
    input.output_tokens_details ??
    input.output_token_details;

  const usage: UsageInfo = {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens:
      detailsNumber(inputDetails, "cached_tokens") ??
      finiteNumber(input.cache_read_input_tokens),
    cacheWriteTokens: finiteNumber(input.cache_creation_input_tokens),
  };
  const optional: UsageInfo = {
    reasoningTokens: detailsNumber(outputDetails, "reasoning_tokens"),
    inputImageTokens: detailsNumber(inputDetails, "image_tokens"),
    outputImageTokens: detailsNumber(outputDetails, "image_tokens"),
    inputImageCount: detailsNumber(inputDetails, "image_count"),
    outputImageCount: detailsNumber(outputDetails, "image_count"),
    inputAudioTokens:
      detailsNumber(inputDetails, "audio_tokens") ??
      finiteNumber(input.input_audio_tokens),
    outputAudioTokens:
      detailsNumber(outputDetails, "audio_tokens") ??
      finiteNumber(input.output_audio_tokens),
  };

  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) {
      (usage as Record<string, unknown>)[key] = value;
    }
  }

  return Object.values(usage).some((value) => value !== undefined)
    ? usage
    : undefined;
}
