import type { ModelPricing } from "@sourceweft/db";

export type LiteLLMEntry = {
  input_cost_per_token?: number | null;
  output_cost_per_token?: number | null;
  cache_read_input_token_cost?: number | null;
  cache_creation_input_token_cost?: number | null;
  output_cost_per_reasoning_token?: number | null;
  input_cost_per_image_token?: number | null;
  output_cost_per_image_token?: number | null;
  input_cost_per_audio_token?: number | null;
  output_cost_per_audio_token?: number | null;
  input_cost_per_image?: number | null;
  output_cost_per_image?: number | null;
  litellm_provider?: string | null;
  mode?: string | null;
  supports_vision?: boolean | null;
  supports_function_calling?: boolean | null;
  supports_parallel_function_calling?: boolean | null;
  supports_response_schema?: boolean | null;
  supports_tool_choice?: boolean | null;
  supports_prompt_caching?: boolean | null;
  supports_reasoning?: boolean | null;
  supports_minimal_reasoning_effort?: boolean | null;
  supports_low_reasoning_effort?: boolean | null;
  supports_high_reasoning_effort?: boolean | null;
  supports_max_reasoning_effort?: boolean | null;
  supports_xhigh_reasoning_effort?: boolean | null;
  supports_none_reasoning_effort?: boolean | null;
  max_input_tokens?: number | null;
  max_output_tokens?: number | null;
  max_completion_tokens?: number | null;
};

export type LiteLLMData = Record<string, LiteLLMEntry>;
export type LiteLLMGatewayKind =
  | "chat"
  | "rerank"
  | "embedding"
  | "asr"
  | "tts"
  | "vision"
  | "image"
  | "video";

export type ModelAliasMatch =
  | { type: "matched"; key: string }
  | { type: "unmatched" }
  | { type: "ambiguous"; candidates: string[] };

export type LiteLLMModelMatch =
  | {
      type: "matched";
      key: string;
      entry: LiteLLMEntry;
      kind: LiteLLMGatewayKind | null;
      provider: string | null;
    }
  | { type: "unmatched" }
  | { type: "ambiguous"; candidates: string[] }
  | { type: "provider_mismatch"; key: string; entryProvider: string | null };

export type LiteLLMResolvedCapabilities = Pick<
  ModelPricing,
  | "litellm_provider"
  | "litellm_mode"
  | "supportsImageInput"
  | "supports_function_calling"
  | "supports_parallel_function_calling"
  | "supports_response_schema"
  | "supports_tool_choice"
  | "supports_prompt_caching"
  | "max_input_tokens"
  | "max_output_tokens"
  | "max_completion_tokens"
> & {
  supportedParameters: string[];
  /**
   * Present only for reasoning models: derived from LiteLLM's
   * `supports_reasoning` + `supports_{minimal,xhigh,max}_reasoning_effort`
   * flags. Absent (not `[]`) for non-reasoning models so config-sync never
   * freezes an empty list into the user-protected fields.
   */
  supportedEfforts?: Array<"minimal" | "low" | "medium" | "high" | "xhigh">;
};

function normalizeModelPart(alias: string): string {
  const trimmed = alias.trim();
  if (!trimmed) {
    return "";
  }
  const parts = trimmed.split("/").filter((part) => part.length > 0);
  return (parts.at(-1) ?? trimmed).toLowerCase();
}

const DEFAULT_LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export async function fetchLiteLLMPricing(
  pricingUrl: string = DEFAULT_LITELLM_PRICING_URL,
): Promise<LiteLLMData> {
  const response = await fetch(pricingUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch LiteLLM pricing: ${response.statusText}`);
  }
  return response.json() as Promise<LiteLLMData>;
}

function normalizeLiteLLMProvider(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  return value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_")
    .replace(/_+/g, "_");
}

export function resolveLiteLLMProviderForGateway(input: {
  providerKind: string;
  providerName?: string | null;
  baseUrl?: string | null;
}) {
  const providerKind = normalizeLiteLLMProvider(input.providerKind);
  const providerName = normalizeLiteLLMProvider(input.providerName);
  const baseUrl = input.baseUrl?.trim().toLowerCase() ?? "";

  if (providerKind === "openrouter") return "openrouter";
  if (providerKind === "deepinfra") return "deepinfra";
  if (providerKind === "siliconflow_cn") return "siliconflow";
  if (providerKind === "openai") return "openai";
  if (providerKind === "azure_openai") return "azure";
  if (providerKind === "gemini") return "gemini";
  if (providerKind === "anthropic") return "anthropic";

  // Fallback: attempt to identify provider from the configured base URL.
  // This heuristic is fragile — gateway configs should set a known providerKind.
  return resolveLiteLLMProviderFromBaseUrl(baseUrl, providerName, providerKind);
}

function resolveLiteLLMProviderFromBaseUrl(
  baseUrl: string,
  providerName: string | null,
  _providerKind: string | null,
): string | null {
  if (baseUrl.includes("api.together.ai")) return "together_ai";
  if (baseUrl.includes("api.deepinfra.com")) return "deepinfra";
  if (baseUrl.includes("api.siliconflow.cn")) return "siliconflow";
  if (baseUrl.includes("openrouter.ai")) return "openrouter";
  if (baseUrl.includes("api.openai.com")) return "openai";

  if (providerName === "together" || providerName === "togetherai") {
    return "together_ai";
  }
  if (providerName === "siliconflow_cn" || providerName === "siliconflow") {
    return "siliconflow";
  }

  return providerName;
}

function stripModelVersion(value: string) {
  const [model, suffix] = value.split(":", 2);
  const stripped = (model ?? value)
    .replace(/[-_.]?(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?([0-2]\d|3[01])$/i, "")
    .replace(/[-_.]?v\d+(\.\d+)*$/i, "")
    .replace(/[-_.]?(latest|preview|beta|alpha)$/i, "");
  return suffix && suffix !== "free" ? `${stripped}:${suffix}` : stripped;
}

function buildLiteLLMLookup(litellmKeys: string[]) {
  const lookup = new Map<string, string[]>();
  for (const key of litellmKeys) {
    const normalized = key.trim().toLowerCase();
    const entries = lookup.get(normalized) ?? [];
    entries.push(key);
    lookup.set(normalized, entries);
  }
  return lookup;
}

function lookupUniqueKey(
  lookup: Map<string, string[]>,
  key: string,
): ModelAliasMatch {
  const matches = lookup.get(key.trim().toLowerCase()) ?? [];
  if (matches.length === 0) {
    return { type: "unmatched" };
  }
  if (matches.length === 1 && matches[0]) {
    return { type: "matched", key: matches[0] };
  }
  return { type: "ambiguous", candidates: matches };
}

function mergeLiteLLMEntries(
  primary: LiteLLMEntry,
  fallback: LiteLLMEntry | null,
): LiteLLMEntry {
  if (!fallback) {
    return primary;
  }

  return Object.fromEntries(
    Array.from(
      new Set([...Object.keys(fallback), ...Object.keys(primary)]),
    ).map((key) => {
      const primaryValue = primary[key as keyof LiteLLMEntry];
      return [
        key,
        primaryValue === undefined || primaryValue === null
          ? fallback[key as keyof LiteLLMEntry]
          : primaryValue,
      ];
    }),
  ) as LiteLLMEntry;
}

function providerCompatible(input: {
  entry: LiteLLMEntry;
  key: string;
  modelId: string;
  provider: string | null;
}) {
  if (!input.provider) {
    return false;
  }
  const entryProvider = normalizeLiteLLMProvider(input.entry.litellm_provider);
  const provider = normalizeLiteLLMProvider(input.provider);
  if (entryProvider) {
    return entryProvider === provider;
  }
  return input.key.toLowerCase().startsWith(`${provider}/`);
}

function resolveLiteLLMKind(entry: LiteLLMEntry): LiteLLMGatewayKind | null {
  const mode = normalizeMode(entry.mode);
  if (!mode) {
    return null;
  }

  if (mode.includes("embedding")) return "embedding";
  if (mode.includes("rerank")) return "rerank";
  if (
    mode.includes("speech_to_text") ||
    mode.includes("transcription") ||
    mode.includes("audio_transcription") ||
    mode === "asr"
  ) {
    return "asr";
  }
  if (
    mode.includes("text_to_speech") ||
    mode.includes("audio_speech") ||
    mode === "tts"
  ) {
    return "tts";
  }
  if (mode.includes("video")) return "video";
  if (mode.includes("image_generation") || mode === "image") return "image";

  const textMode =
    mode === "chat" ||
    mode === "completion" ||
    mode === "responses" ||
    mode.includes("text_generation") ||
    mode.includes("text-generation") ||
    mode.includes("chat");

  if (!textMode) {
    return null;
  }

  return entry.supports_vision === true ? "vision" : "chat";
}

export function resolveLiteLLMModelMatch(input: {
  modelId: string;
  provider: string | null;
  litellmData: LiteLLMData;
}): LiteLLMModelMatch {
  const modelId = input.modelId.trim();
  const provider = normalizeLiteLLMProvider(input.provider);
  if (!modelId || !provider) {
    return { type: "unmatched" };
  }

  const litellmKeys = Object.keys(input.litellmData);
  const lookup = buildLiteLLMLookup(litellmKeys);
  const splitModelId = normalizeModelPart(modelId);
  const strippedModelId = stripModelVersion(modelId);
  const strippedSplitModelId = stripModelVersion(splitModelId);
  const candidates = Array.from(
    new Set([
      `${provider}/${modelId}`,
      modelId,
      `${provider}/${strippedModelId}`,
      strippedModelId,
      splitModelId,
      strippedSplitModelId,
    ].filter((candidate) => candidate.trim().length > 0)),
  );

  for (const candidate of candidates) {
    const matched = lookupUniqueKey(lookup, candidate);
    if (matched.type === "ambiguous") {
      return matched;
    }
    if (matched.type !== "matched") {
      continue;
    }

    const entry = input.litellmData[matched.key];
    if (!entry) {
      continue;
    }
    const bareEntry =
      input.litellmData[modelId] ??
      input.litellmData[strippedModelId] ??
      input.litellmData[splitModelId] ??
      input.litellmData[strippedSplitModelId] ??
      null;
    const mergedEntry = mergeLiteLLMEntries(entry, bareEntry);
    if (
      !providerCompatible({
        entry: mergedEntry,
        key: matched.key,
        modelId,
        provider,
      })
    ) {
      return {
        type: "provider_mismatch",
        key: matched.key,
        entryProvider: normalizeLiteLLMProvider(mergedEntry.litellm_provider),
      };
    }

    return {
      type: "matched",
      key: matched.key,
      entry: mergedEntry,
      kind: resolveLiteLLMKind(mergedEntry),
      provider,
    };
  }

  return { type: "unmatched" };
}

export function hasLiteLLMPricing(entry: LiteLLMEntry) {
  return [
    entry.input_cost_per_token,
    entry.output_cost_per_token,
    entry.cache_read_input_token_cost,
    entry.cache_creation_input_token_cost,
    entry.output_cost_per_reasoning_token,
    entry.input_cost_per_image_token,
    entry.output_cost_per_image_token,
    entry.input_cost_per_audio_token,
    entry.output_cost_per_audio_token,
    entry.input_cost_per_image,
    entry.output_cost_per_image,
  ].some((value) => typeof value === "number" && Number.isFinite(value));
}

export function autoMatchModelAlias(
  alias: string,
  litellmKeys: string[],
): ModelAliasMatch {
  if (litellmKeys.includes(alias)) {
    return { type: "matched", key: alias };
  }

  const modelPart = normalizeModelPart(alias);
  if (!modelPart) {
    return { type: "unmatched" };
  }

  for (const key of litellmKeys) {
    const keyModel = normalizeModelPart(key);
    if (!keyModel) {
      continue;
    }
    if (keyModel === modelPart) {
      return { type: "matched", key };
    }
  }

  const candidates: string[] = [];
  for (const key of litellmKeys) {
    const keyModel = normalizeModelPart(key);
    if (!keyModel) {
      continue;
    }
    if (keyModel.includes(modelPart) || modelPart.includes(keyModel)) {
      candidates.push(key);
    }
  }

  if (candidates.length === 1) {
    const candidate = candidates[0];
    if (candidate) {
      return { type: "matched", key: candidate };
    }
  }

  if (candidates.length > 1) {
    return { type: "ambiguous", candidates };
  }

  return { type: "unmatched" };
}

function normalizeMode(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null;
}

function normalizeBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function normalizeFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dedupeParameters(parameters: string[]) {
  return Array.from(
    new Set(
      parameters
        .map((parameter) => parameter.trim().toLowerCase())
        .filter((parameter) => parameter.length > 0),
    ),
  );
}

export function deriveSupportedParameters(
  entry: LiteLLMEntry,
): LiteLLMResolvedCapabilities["supportedParameters"] {
  const parameters: string[] = [];

  if (entry.supports_function_calling === true) {
    parameters.push("tools", "tool_choice");
  }
  if (entry.supports_parallel_function_calling === true) {
    parameters.push("parallel_tool_calls");
  }
  if (entry.supports_response_schema === true) {
    parameters.push("response_format");
  }
  if (entry.supports_tool_choice === true) {
    parameters.push("tool_choice");
  }
  if (entry.supports_prompt_caching === true) {
    parameters.push("prompt_cache");
  }
  if (entry.supports_reasoning === true) {
    parameters.push("reasoning_effort");
  }

  return dedupeParameters(parameters);
}

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh"] as const;

/**
 * Map LiteLLM's reasoning-effort flags onto our effort vocabulary. A reasoning
 * model supports low/medium/high by default; the boundary tiers minimal and
 * xhigh are gated on their explicit LiteLLM flags (`max` folds into `xhigh`).
 * Returns [] for non-reasoning models so callers can omit the key entirely.
 */
export function deriveSupportedEfforts(
  entry: LiteLLMEntry,
): NonNullable<LiteLLMResolvedCapabilities["supportedEfforts"]> {
  if (entry.supports_reasoning !== true) {
    return [];
  }
  const efforts = new Set<(typeof EFFORT_ORDER)[number]>([
    "low",
    "medium",
    "high",
  ]);
  if (entry.supports_minimal_reasoning_effort === true) {
    efforts.add("minimal");
  }
  if (
    entry.supports_xhigh_reasoning_effort === true ||
    entry.supports_max_reasoning_effort === true
  ) {
    efforts.add("xhigh");
  }
  return EFFORT_ORDER.filter((effort) => efforts.has(effort));
}

export function resolveLiteLLMCapabilities(
  entry: LiteLLMEntry,
): LiteLLMResolvedCapabilities {
  const mode = normalizeMode(entry.mode);
  const supportsImageInput =
    entry.supports_vision === true ||
    mode?.includes("vision") === true;

  return {
    litellm_provider:
      typeof entry.litellm_provider === "string" &&
      entry.litellm_provider.trim().length > 0
        ? entry.litellm_provider.trim()
        : null,
    litellm_mode: mode,
    supportsImageInput,
    supports_function_calling: normalizeBoolean(entry.supports_function_calling),
    supports_parallel_function_calling: normalizeBoolean(
      entry.supports_parallel_function_calling,
    ),
    supports_response_schema: normalizeBoolean(entry.supports_response_schema),
    supports_tool_choice: normalizeBoolean(entry.supports_tool_choice),
    supports_prompt_caching: normalizeBoolean(entry.supports_prompt_caching),
    max_input_tokens: normalizeFiniteNumber(entry.max_input_tokens),
    max_output_tokens: normalizeFiniteNumber(entry.max_output_tokens),
    max_completion_tokens: normalizeFiniteNumber(entry.max_completion_tokens),
    supportedParameters: deriveSupportedParameters(entry),
    ...(entry.supports_reasoning === true
      ? { supportedEfforts: deriveSupportedEfforts(entry) }
      : {}),
  };
}
