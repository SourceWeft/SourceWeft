import { config } from "../../../config";
import { logger } from "../../../logger";
import {
  canonicalModelId,
  canonicalProviderKey,
  type ModelModality,
  type ModelPricingInfo,
  type NormalizedModelInfo,
  type ReasoningEffort,
} from "../types";

type ModelsDevModel = {
  id?: string;
  reasoning?: boolean;
  reasoning_options?: Array<{ type?: string; values?: string[] }>;
  tool_call?: boolean;
  structured_output?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    reasoning?: number;
    input_audio?: number;
    output_audio?: number;
  };
};

type ModelsDevApi = Record<string, { models?: Record<string, ModelsDevModel> }>;

const EFFORT_ALIASES: Record<string, ReasoningEffort> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  max: "xhigh",
  xhigh: "xhigh",
};

function lowerStrings(values: unknown): string[] {
  return Array.isArray(values)
    ? values
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim().toLowerCase())
    : [];
}

function toEfforts(model: ModelsDevModel): ReasoningEffort[] {
  const values = (model.reasoning_options ?? []).flatMap((opt) =>
    lowerStrings(opt?.values),
  );
  const efforts = values
    .map((value) => EFFORT_ALIASES[value])
    .filter((effort): effort is ReasoningEffort => Boolean(effort));
  // A reasoning model with no advertised tiers still supports the common ones.
  return efforts.length > 0 ? efforts : ["low", "medium", "high"];
}

function toModality(model: ModelsDevModel): ModelModality | undefined {
  const output = lowerStrings(model.modalities?.output);
  const input = lowerStrings(model.modalities?.input);
  if (output.includes("video")) return "video";
  if (output.includes("image")) return "image";
  if (output.includes("audio")) return "tts";
  if (output.includes("embedding")) return "embedding";
  if (input.includes("image") || input.includes("video")) return "vision";
  return "chat";
}

function toPricing(model: ModelsDevModel): ModelPricingInfo | undefined {
  const cost = model.cost;
  if (!cost) return undefined;
  // models.dev quotes USD per 1M tokens.
  const perToken = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? value / 1e6 : null;
  const pricing: ModelPricingInfo = {
    inputPerToken: perToken(cost.input),
    outputPerToken: perToken(cost.output),
    cacheReadPerToken: perToken(cost.cache_read),
    cacheWritePerToken: perToken(cost.cache_write),
    reasoningOutputPerToken: perToken(cost.reasoning),
    audioInputPerToken: perToken(cost.input_audio),
    audioOutputPerToken: perToken(cost.output_audio),
  };
  return Object.values(pricing).some((v) => v !== null) ? pricing : undefined;
}

function toFinite(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeModel(
  modelId: string,
  model: ModelsDevModel,
  providerKey?: string,
): NormalizedModelInfo {
  const reasoning = model.reasoning === true;
  const input = lowerStrings(model.modalities?.input);
  const rawId =
    typeof model.id === "string" && model.id.trim() ? model.id : modelId;
  return {
    id: canonicalModelId(rawId),
    provider: canonicalProviderKey(providerKey),
    modality: toModality(model),
    reasoning,
    reasoningEfforts: reasoning ? toEfforts(model) : [],
    toolCall: model.tool_call === true,
    structuredOutput: model.structured_output === true,
    vision: input.includes("image"),
    contextTokens: toFinite(model.limit?.context),
    maxOutputTokens: toFinite(model.limit?.output),
    pricing: toPricing(model),
    sources: ["models.dev"],
  };
}

/**
 * Fetch models.dev's api.json and adapt every provider/model entry into the
 * neutral shape. Network/parse failure logs and returns [] so the registry
 * degrades to its other sources rather than throwing on the preheat path.
 */
export async function loadModelsDevModels(): Promise<NormalizedModelInfo[]> {
  try {
    const response = await fetch(config.modelsDevApiUrl);
    if (!response.ok) {
      logger.warn("models.dev catalog fetch failed", {
        status: response.status,
      });
      return [];
    }
    const payload = (await response.json()) as ModelsDevApi;
    const out: NormalizedModelInfo[] = [];
    for (const [providerKey, provider] of Object.entries(payload)) {
      if (!provider || typeof provider !== "object") continue;
      for (const [modelId, model] of Object.entries(provider.models ?? {})) {
        // One malformed entry must not drop the whole (6000+ model) source.
        if (!model || typeof model !== "object") continue;
        try {
          out.push(normalizeModel(modelId, model, providerKey));
        } catch {
          // skip a bad entry
        }
      }
    }
    return out;
  } catch (error) {
    logger.warn("models.dev catalog load errored", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
