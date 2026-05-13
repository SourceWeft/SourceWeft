import type { ModelPricing } from "../db/schema-types";

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
  max_input_tokens?: number | null;
  max_output_tokens?: number | null;
  max_completion_tokens?: number | null;
};

export type LiteLLMData = Record<string, LiteLLMEntry>;

export type ModelAliasMatch =
  | { type: "matched"; key: string }
  | { type: "unmatched" }
  | { type: "ambiguous"; candidates: string[] };

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
  supportedEfforts: Array<"minimal" | "low" | "medium" | "high" | "xhigh">;
};

function normalizeModelPart(alias: string): string {
  const trimmed = alias.trim();
  if (!trimmed) {
    return "";
  }
  const parts = trimmed.split("/").filter((part) => part.length > 0);
  return (parts.at(-1) ?? trimmed).toLowerCase();
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

  return dedupeParameters(parameters);
}

export function deriveSupportedEfforts(
  _entry: LiteLLMEntry,
): LiteLLMResolvedCapabilities["supportedEfforts"] {
  return [];
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
    supportedEfforts: deriveSupportedEfforts(entry),
  };
}
