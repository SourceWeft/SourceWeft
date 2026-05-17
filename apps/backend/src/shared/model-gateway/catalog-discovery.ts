import { logger } from "../logger";
import type { ModelGatewayProfileKind } from "./types";
import {
  fetchLiteLLMPricing,
  hasLiteLLMPricing,
  resolveLiteLLMCapabilities,
  resolveLiteLLMModelMatch,
  resolveLiteLLMProviderForGateway,
  type LiteLLMData,
  type LiteLLMEntry,
} from "./litellm-capabilities";
import type { GlobalProfilePricingEntry } from "./global-config";

export type CatalogModelKind = ModelGatewayProfileKind;

export type CatalogModelCandidate = {
  displayName?: string;
  kind: CatalogModelKind;
  litellmEntry?: LiteLLMEntry;
  litellmKey?: string;
  modelId: string;
  pricing?: GlobalProfilePricingEntry | null;
  providerCatalogSource: string;
  providerCatalogGatewaySlug: string;
  supportedEfforts?: Array<"minimal" | "low" | "medium" | "high" | "xhigh">;
  supportedParameters?: string[];
  supportsImageInput?: boolean;
  architecture?: Record<string, unknown>;
  contextLength?: number | null;
  defaultParameters?: Record<string, unknown> | null;
  maxCompletionTokens?: number | null;
};

export type CatalogDiscoveryGateway = {
  slug: string;
  providerName: string;
  providerKind: string;
  baseUrl: string;
  apiKey?: string;
  defaultHeaders?: Record<string, string>;
  supports: string[];
};

const OPENROUTER_MODELS_API_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_APP_TITLE = "SourceWeft";
const OPENROUTER_APP_REFERER = "https://sourceweft.com";

const SUPPORTED_DYNAMIC_KINDS: Record<CatalogModelKind, string[]> = {
  chat: ["chat", "tool_calling"],
  vision: ["chat", "tool_calling"],
  image: ["image"],
  embedding: ["embeddings"],
  rerank: ["rerank"],
  asr: ["asr"],
  tts: ["tts"],
  video: ["video"],
};

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toPriceNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return Number(parsed.toPrecision(15));
}

function parseOpenRouterPricing(value: unknown): GlobalProfilePricingEntry | null {
  const pricing = toObjectRecord(value);
  if (!pricing) {
    return null;
  }

  const parsed: GlobalProfilePricingEntry = {
    source: "openrouter",
    inputCostPerToken: toPriceNumber(pricing.prompt),
    outputCostPerToken: toPriceNumber(pricing.completion),
    cacheReadInputTokenCost: toPriceNumber(pricing.input_cache_read),
    inputCostPerImageToken: toPriceNumber(pricing.image),
  };

  return parsed.inputCostPerToken !== null ||
      parsed.outputCostPerToken !== null ||
      parsed.cacheReadInputTokenCost !== null ||
      parsed.inputCostPerImageToken !== null
    ? parsed
    : null;
}

function parseOpenAIModelIds(payload: unknown) {
  const record = toObjectRecord(payload);
  const data = Array.isArray(record?.data) ? record.data : [];
  return data
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }
      if (!item || typeof item !== "object") {
        return "";
      }
      const id = (item as Record<string, unknown>).id;
      return typeof id === "string" ? id.trim() : "";
    })
    .filter((id) => id.length > 0);
}

function normalizeSupportedEfforts(supportedParameters: string[]) {
  return supportedParameters.includes("reasoning") ||
    supportedParameters.includes("reasoning_effort")
    ? (["minimal", "low", "medium", "high", "xhigh"] as Array<
        "minimal" | "low" | "medium" | "high" | "xhigh"
      >)
    : [];
}

function kindAllowed(kind: CatalogModelKind, allowList?: Set<CatalogModelKind>) {
  return !allowList || allowList.has(kind);
}

export function providerSupportsKind(
  gateway: CatalogDiscoveryGateway,
  kind: CatalogModelKind,
) {
  const supports = new Set(
    gateway.supports.map((item) => item.trim().toLowerCase()),
  );
  const required = SUPPORTED_DYNAMIC_KINDS[kind] ?? [];
  if (required.length === 0) {
    return false;
  }
  if (kind === "chat" || kind === "vision") {
    return supports.has("chat") && supports.has("tool_calling");
  }
  return required.some((item) => supports.has(item));
}

export function buildLiteLLMPricingEntry(
  entry: LiteLLMEntry,
): GlobalProfilePricingEntry {
  return {
    source: "litellm",
    inputCostPerToken: entry.input_cost_per_token ?? null,
    outputCostPerToken: entry.output_cost_per_token ?? null,
    cacheReadInputTokenCost: entry.cache_read_input_token_cost ?? null,
    cacheCreationInputTokenCost: entry.cache_creation_input_token_cost ?? null,
    outputCostPerReasoningToken:
      entry.output_cost_per_reasoning_token ?? null,
    inputCostPerImageToken: entry.input_cost_per_image_token ?? null,
    outputCostPerImageToken: entry.output_cost_per_image_token ?? null,
    inputCostPerAudioToken: entry.input_cost_per_audio_token ?? null,
    outputCostPerAudioToken: entry.output_cost_per_audio_token ?? null,
    inputCostPerImage: entry.input_cost_per_image ?? null,
    outputCostPerImage: entry.output_cost_per_image ?? null,
  };
}

function buildCandidateFromLiteLLM(input: {
  gateway: CatalogDiscoveryGateway;
  litellmData: LiteLLMData;
  modelId: string;
  source: string;
}) {
  const provider = resolveLiteLLMProviderForGateway({
    providerKind: input.gateway.providerKind,
    providerName: input.gateway.providerName,
    baseUrl: input.gateway.baseUrl,
  });
  const match = resolveLiteLLMModelMatch({
    modelId: input.modelId,
    provider,
    litellmData: input.litellmData,
  });

  if (match.type !== "matched" || !match.kind) {
    logger.warn("Skipped catalog model without LiteLLM match", {
      provider: input.gateway.providerName,
      modelId: input.modelId,
      reason: match.type,
    });
    return null;
  }

  if (!hasLiteLLMPricing(match.entry)) {
    logger.warn("Skipped catalog model without LiteLLM pricing", {
      provider: input.gateway.providerName,
      modelId: input.modelId,
      litellmKey: match.key,
    });
    return null;
  }

  if ((match.kind === "chat" || match.kind === "vision") &&
      match.entry.supports_function_calling !== true) {
    logger.warn("Skipped catalog chat model without tool support", {
      provider: input.gateway.providerName,
      modelId: input.modelId,
      litellmKey: match.key,
    });
    return null;
  }

  if (!providerSupportsKind(input.gateway, match.kind)) {
    logger.warn("Skipped catalog model for unsupported gateway kind", {
      provider: input.gateway.providerName,
      modelId: input.modelId,
      kind: match.kind,
    });
    return null;
  }

  const capabilities = resolveLiteLLMCapabilities(match.entry);
  return {
    kind: match.kind,
    litellmEntry: match.entry,
    litellmKey: match.key,
    modelId: input.modelId,
    pricing: buildLiteLLMPricingEntry(match.entry),
    providerCatalogSource: input.source,
    providerCatalogGatewaySlug: input.gateway.slug,
    supportedEfforts: capabilities.supportedEfforts,
    supportedParameters: capabilities.supportedParameters,
    supportsImageInput: capabilities.supportsImageInput,
    maxCompletionTokens: capabilities.max_completion_tokens ?? null,
  } satisfies CatalogModelCandidate;
}

async function discoverOpenRouterCatalog(input: {
  gateway: CatalogDiscoveryGateway;
  kinds?: Set<CatalogModelKind>;
  litellmData?: LiteLLMData;
}) {
  const response = await fetch(OPENROUTER_MODELS_API_URL, {
    headers: {
      "User-Agent": "sourceweft-model-gateway/1.0",
      "X-Title": OPENROUTER_APP_TITLE,
      "HTTP-Referer": OPENROUTER_APP_REFERER,
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to load OpenRouter model catalog: ${response.status}`);
  }

  const payload = (await response.json()) as { data?: unknown };
  const data = Array.isArray(payload.data) ? payload.data : [];
  const items: CatalogModelCandidate[] = [];

  for (const rawModel of data) {
    const model = toObjectRecord(rawModel);
    const modelId = typeof model?.id === "string" ? model.id.trim() : "";
    if (!modelId || !modelId.includes("/")) {
      continue;
    }

    const architecture = toObjectRecord(model?.architecture) ?? {};
    const topProvider = toObjectRecord(model?.top_provider);
    const inputModalities = toStringArray(architecture.input_modalities);
    const outputModalities = toStringArray(architecture.output_modalities);
    const supportedParameters = toStringArray(model?.supported_parameters);
    const hasImageInput = inputModalities.includes("image");
    const hasTextOutput = outputModalities.includes("text");
    const hasImageOutput = outputModalities.includes("image");
    const displayName =
      typeof model?.name === "string" && model.name.trim().length > 0
        ? model.name.trim()
        : modelId;
    const pricing = parseOpenRouterPricing(model?.pricing);
    const common = {
      architecture,
      contextLength: toFiniteNumber(model?.context_length),
      defaultParameters: toObjectRecord(model?.default_parameters),
      displayName,
      maxCompletionTokens: toFiniteNumber(topProvider?.max_completion_tokens),
      modelId,
      pricing,
      providerCatalogGatewaySlug: input.gateway.slug,
      providerCatalogSource: "openrouter-models",
      supportedEfforts: normalizeSupportedEfforts(supportedParameters),
      supportedParameters,
    };

    const push = (kind: CatalogModelKind, extra: Partial<CatalogModelCandidate> = {}) => {
      if (!kindAllowed(kind, input.kinds) || !providerSupportsKind(input.gateway, kind)) {
        return;
      }
      if ((kind === "chat" || kind === "vision") &&
          !supportedParameters.includes("tools")) {
        return;
      }
      items.push({
        ...common,
        kind,
        ...extra,
      });
    };

    if (hasImageOutput) {
      push("image");
    }
    if (hasImageInput && hasTextOutput && !hasImageOutput) {
      push("vision", { supportsImageInput: true });
    }
    if (hasTextOutput && !hasImageOutput) {
      push("chat");
    }
  }

  return items;
}

async function discoverOpenAICompatibleCatalog(input: {
  gateway: CatalogDiscoveryGateway;
  kinds?: Set<CatalogModelKind>;
  litellmData: LiteLLMData;
}) {
  const response = await fetch(`${normalizeBaseUrl(input.gateway.baseUrl)}/models`, {
    headers: {
      ...(input.gateway.defaultHeaders ?? {}),
      ...(input.gateway.apiKey ? { Authorization: `Bearer ${input.gateway.apiKey}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to load model catalog: ${response.status}`);
  }

  const ids = parseOpenAIModelIds(await response.json());
  const items: CatalogModelCandidate[] = [];
  for (const modelId of ids) {
    const item = buildCandidateFromLiteLLM({
      gateway: input.gateway,
      litellmData: input.litellmData,
      modelId,
      source: `${input.gateway.providerKind}-models`,
    });
    if (!item || !kindAllowed(item.kind, input.kinds)) {
      continue;
    }
    items.push(item);
  }
  return items;
}

export async function discoverGatewayCatalog(input: {
  gateway: CatalogDiscoveryGateway;
  kinds?: CatalogModelKind[];
  litellmData?: LiteLLMData;
}) {
  const kinds = input.kinds && input.kinds.length > 0
    ? new Set(input.kinds)
    : undefined;

  if (input.gateway.providerKind === "openrouter") {
    return discoverOpenRouterCatalog({
      gateway: input.gateway,
      kinds,
      litellmData: input.litellmData,
    });
  }

  const litellmData = input.litellmData ?? await fetchLiteLLMPricing();
  return discoverOpenAICompatibleCatalog({
    gateway: input.gateway,
    kinds,
    litellmData,
  });
}

export async function discoverByokModelCandidates(input: {
  providerKind: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  defaultHeaders?: Record<string, string>;
}) {
  const gateway: CatalogDiscoveryGateway = {
    slug: `byok-${input.providerName}`,
    providerKind: input.providerKind,
    providerName: input.providerName,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    defaultHeaders: input.defaultHeaders,
    supports: ["chat", "embeddings", "rerank", "asr", "image", "tool_calling"],
  };
  const response = await fetch(`${normalizeBaseUrl(gateway.baseUrl)}/models`, {
    headers: {
      ...(gateway.defaultHeaders ?? {}),
      Authorization: `Bearer ${gateway.apiKey}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to load BYOK model catalog: ${response.status}`);
  }

  return parseOpenAIModelIds(await response.json()).map((modelId) => ({
    modelId,
    displayName: modelId,
  }));
}
