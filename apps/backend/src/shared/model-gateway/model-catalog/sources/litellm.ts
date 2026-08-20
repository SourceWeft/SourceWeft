import { config } from "../../../config";
import { logger } from "../../../logger";
import {
  deriveSupportedEfforts,
  fetchLiteLLMPricing,
  type LiteLLMEntry,
} from "../../litellm-capabilities";
import {
  canonicalModelId,
  type ModelModality,
  type ModelPricingInfo,
  type NormalizedModelInfo,
} from "../types";

function toModality(entry: LiteLLMEntry): ModelModality | undefined {
  const mode = entry.mode?.trim().toLowerCase();
  if (!mode) return undefined;
  if (mode.includes("embedding")) return "embedding";
  if (mode === "tts" || mode.includes("audio_speech")) return "tts";
  if (mode.includes("video")) return "video";
  if (mode === "image_generation" || mode === "image") return "image";
  if (
    mode === "chat" ||
    mode === "completion" ||
    mode === "responses" ||
    mode.includes("chat")
  ) {
    return entry.supports_vision === true ? "vision" : "chat";
  }
  return undefined;
}

function toFinite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toPricing(entry: LiteLLMEntry): ModelPricingInfo | undefined {
  const pricing: ModelPricingInfo = {
    inputPerToken: toFinite(entry.input_cost_per_token),
    outputPerToken: toFinite(entry.output_cost_per_token),
    cacheReadPerToken: toFinite(entry.cache_read_input_token_cost),
    cacheWritePerToken: toFinite(entry.cache_creation_input_token_cost),
    reasoningOutputPerToken: toFinite(entry.output_cost_per_reasoning_token),
    audioInputPerToken: toFinite(entry.input_cost_per_audio_token),
    audioOutputPerToken: toFinite(entry.output_cost_per_audio_token),
    inputPerImage: toFinite(entry.input_cost_per_image),
    outputPerImage: toFinite(entry.output_cost_per_image),
  };
  return Object.values(pricing).some((v) => v !== null) ? pricing : undefined;
}

function normalizeEntry(key: string, entry: LiteLLMEntry): NormalizedModelInfo {
  const reasoning = entry.supports_reasoning === true;
  return {
    id: canonicalModelId(key),
    modality: toModality(entry),
    reasoning,
    reasoningEfforts: reasoning ? deriveSupportedEfforts(entry) : [],
    toolCall: entry.supports_function_calling === true,
    structuredOutput: entry.supports_response_schema === true,
    vision: entry.supports_vision === true,
    contextTokens: toFinite(entry.max_input_tokens),
    maxOutputTokens: toFinite(
      entry.max_completion_tokens ?? entry.max_output_tokens,
    ),
    pricing: toPricing(entry),
    sources: ["litellm"],
  };
}

/**
 * Fetch the BerriAI LiteLLM dataset and adapt each entry into the neutral
 * shape. Network/parse failure logs and returns [] so the registry degrades to
 * its other sources.
 */
export async function loadLiteLLMModels(): Promise<NormalizedModelInfo[]> {
  try {
    const data = await fetchLiteLLMPricing(config.litellmPricingUrl);
    return Object.entries(data)
      .filter(([, entry]) => entry && typeof entry === "object")
      .map(([key, entry]) => normalizeEntry(key, entry));
  } catch (error) {
    logger.warn("LiteLLM catalog load errored", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
