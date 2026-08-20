import { config } from "../../../config";
import { logger } from "../../../logger";
import {
  deriveSupportedEfforts,
  fetchLiteLLMPricing,
  type LiteLLMEntry,
} from "../../litellm-capabilities";
import {
  canonicalModelId,
  canonicalProviderKey,
  type ImagePricingTier,
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
    inputImageTokenPerToken: toFinite(entry.input_cost_per_image_token),
    outputImageTokenPerToken: toFinite(entry.output_cost_per_image_token),
    inputPerImage: toFinite(entry.input_cost_per_image),
    outputPerImage: toFinite(entry.output_cost_per_image),
  };
  return Object.values(pricing).some((v) => v !== null) ? pricing : undefined;
}

// LiteLLM prices some image models per quality+size with keys like
// `high/1024-x-1024/gpt-image-1`, `azure/hd/1024-x-1024/dall-e-3`, or
// `1024-x-1024/50-steps/stability...`. Parse the base model + quality/size.
const IMAGE_QUALITIES = new Set([
  "low",
  "medium",
  "high",
  "hd",
  "standard",
  "auto",
  "higher",
  "highest",
]);
const SIZE_RE = /^(\d+)-x-(\d+)$/i;

function parseImageSizeKey(
  key: string,
): { baseId: string; quality?: string; size?: string } | null {
  const segs = key.split("/");
  const sizeIdx = segs.findIndex((s) => SIZE_RE.test(s));
  if (sizeIdx < 0) {
    return null;
  }
  const m = SIZE_RE.exec(segs[sizeIdx] ?? "");
  if (!m) {
    return null;
  }
  const size = `${m[1]}x${m[2]}`;
  const prev = sizeIdx > 0 ? (segs[sizeIdx - 1] ?? "").toLowerCase() : "";
  const quality = IMAGE_QUALITIES.has(prev) ? prev : undefined;
  const after = segs.slice(sizeIdx + 1).filter((s) => !/steps?$/i.test(s));
  if (after.length === 0) {
    return null;
  }
  return { baseId: after.join("/"), quality, size };
}

function toTier(
  entry: LiteLLMEntry,
  quality?: string,
  size?: string,
): ImagePricingTier | null {
  const perImage = toFinite(
    entry.input_cost_per_image ?? entry.output_cost_per_image,
  );
  const perPixel = toFinite(
    entry.input_cost_per_pixel ?? entry.output_cost_per_pixel,
  );
  if (perImage === null && perPixel === null) {
    return null;
  }
  return {
    ...(quality ? { quality } : {}),
    ...(size ? { size } : {}),
    perImage,
    perPixel,
  };
}

function normalizeEntry(key: string, entry: LiteLLMEntry): NormalizedModelInfo {
  const reasoning = entry.supports_reasoning === true;
  return {
    id: canonicalModelId(key),
    provider: canonicalProviderKey(entry.litellm_provider),
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

export const testExports = { parseImageSizeKey, toTier };

/**
 * Fetch the BerriAI LiteLLM dataset and adapt each entry into the neutral
 * shape. Network/parse failure logs and returns [] so the registry degrades to
 * its other sources.
 */
export async function loadLiteLLMModels(): Promise<NormalizedModelInfo[]> {
  try {
    const data = await fetchLiteLLMPricing(config.litellmPricingUrl);
    const out: NormalizedModelInfo[] = [];
    for (const [key, entry] of Object.entries(data)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      // A `{quality}/{WxH}/{model}` tier entry → fold into the base model's
      // imageTiers (registry unions tiers across variants) rather than becoming
      // its own model.
      const sizeKey = parseImageSizeKey(key);
      const tier = sizeKey ? toTier(entry, sizeKey.quality, sizeKey.size) : null;
      if (sizeKey && tier) {
        out.push({
          id: canonicalModelId(sizeKey.baseId),
          provider: canonicalProviderKey(entry.litellm_provider),
          modality: "image",
          reasoning: false,
          reasoningEfforts: [],
          toolCall: false,
          structuredOutput: false,
          vision: false,
          pricing: { imageTiers: [tier] },
          sources: ["litellm"],
        });
        continue;
      }
      out.push(normalizeEntry(key, entry));
    }
    return out;
  } catch (error) {
    logger.warn("LiteLLM catalog load errored", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
