import { logger } from "../logger";
import { config } from "../config";
import { createLlmFetch, llmEndpointPolicy } from "./network";
import { OPENROUTER_APP_TITLE } from "./attribution";
import type { ModelGatewayProfileKind } from "./types";
import { modelCatalog } from "./model-catalog/registry";
import type { ModelModality, NormalizedModelInfo } from "./model-catalog/types";
import type { GlobalProfilePricingEntry } from "./global-config";
import { toObjectRecord } from "../records";

export type CatalogModelKind = ModelGatewayProfileKind;

export type CatalogModelCandidate = {
  displayName?: string;
  kind: CatalogModelKind;
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
  apiKeyHeaderName?: string;
  apiKeyHeaderPrefix?: string;
  defaultHeaders?: Record<string, string>;
  supports: string[];
  /**
   * Discovery-format override (from `modelCatalog.format`). "orcarouter" routes
   * an openai-compatible gateway through {@link discoverOrcaRouterCatalog}
   * instead of the LiteLLM-priced generic `/models` path.
   */
  catalogFormat?: "orcarouter";
};

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

function buildAuthHeaders(
  input: Pick<
    CatalogDiscoveryGateway,
    "apiKey" | "apiKeyHeaderName" | "apiKeyHeaderPrefix"
  >,
) {
  if (!input.apiKey) {
    return {};
  }
  if (input.apiKeyHeaderName) {
    return {
      [input.apiKeyHeaderName]: `${input.apiKeyHeaderPrefix ?? ""}${input.apiKey}`,
    };
  }
  return {
    Authorization: `Bearer ${input.apiKey}`,
  };
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

// OrcaRouter and OpenRouter both expose inline pricing under the same
// `prompt`/`completion` keys, so they share this parser — but `source` must name
// the actual serving gateway (provenance), not the shape, so an operator can
// tell whose price a profile carries.
function parseOpenRouterPricing(
  value: unknown,
  source: "openrouter" | "orcarouter",
): GlobalProfilePricingEntry | null {
  const pricing = toObjectRecord(value);
  if (!pricing) {
    return null;
  }

  const parsed: GlobalProfilePricingEntry = {
    source,
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

function kindAllowed(
  kind: CatalogModelKind,
  allowList?: Set<CatalogModelKind>,
) {
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

const MODALITY_TO_KIND: Record<ModelModality, CatalogModelKind> = {
  chat: "chat",
  vision: "vision",
  image: "image",
  embedding: "embedding",
  tts: "tts",
  video: "video",
};

function registryPricing(
  info: NormalizedModelInfo,
): GlobalProfilePricingEntry | null {
  const p = info.pricing;
  if (!p) {
    return null;
  }
  const entry: GlobalProfilePricingEntry = {
    inputCostPerToken: p.inputPerToken ?? null,
    outputCostPerToken: p.outputPerToken ?? null,
    cacheReadInputTokenCost: p.cacheReadPerToken ?? null,
    cacheCreationInputTokenCost: p.cacheWritePerToken ?? null,
    outputCostPerReasoningToken: p.reasoningOutputPerToken ?? null,
    inputCostPerAudioToken: p.audioInputPerToken ?? null,
    outputCostPerAudioToken: p.audioOutputPerToken ?? null,
    inputCostPerImage: p.inputPerImage ?? null,
    outputCostPerImage: p.outputPerImage ?? null,
  };
  return Object.values(entry).some((v) => typeof v === "number") ? entry : null;
}

// A plain openai-compatible provider whose `/models` gives only ids: resolve
// its kind, capabilities, and pricing from the normalized catalog. Same
// registry path as OrcaRouter, just without any provider-inline metadata.
function buildCandidateFromRegistry(input: {
  gateway: CatalogDiscoveryGateway;
  modelId: string;
  source: string;
  resolve: CapabilityResolver;
}): CatalogModelCandidate | null {
  const info = input.resolve(input.modelId, {
    provider: input.gateway.providerName,
  });
  if (!info) {
    logger.warn("Skipped catalog model with no capability match", {
      provider: input.gateway.providerName,
      modelId: input.modelId,
    });
    return null;
  }
  const kind = info.modality ? MODALITY_TO_KIND[info.modality] : "chat";
  if (!providerSupportsKind(input.gateway, kind)) {
    return null;
  }
  const { supportedParameters, supportedEfforts, vision } =
    candidateCapabilityFields(info);
  return {
    kind,
    modelId: input.modelId,
    pricing: registryPricing(info),
    providerCatalogSource: input.source,
    providerCatalogGatewaySlug: input.gateway.slug,
    supportedParameters,
    ...(supportedEfforts.length > 0 ? { supportedEfforts } : {}),
    supportsImageInput: vision,
    contextLength: info.contextTokens ?? null,
    maxCompletionTokens: info.maxOutputTokens ?? null,
  } satisfies CatalogModelCandidate;
}

async function discoverOpenRouterCatalog(input: {
  gateway: CatalogDiscoveryGateway;
  kinds?: Set<CatalogModelKind>;
}) {
  const response = await createLlmFetch(
    llmEndpointPolicy([input.gateway.baseUrl, config.openrouterModelsApiUrl]),
  )(config.openrouterModelsApiUrl, {
    headers: {
      "User-Agent": "sourceweft-model-gateway/1.0",
      "HTTP-Referer": config.openrouterAppReferer,
      "X-OpenRouter-Title": OPENROUTER_APP_TITLE,
      "X-Title": OPENROUTER_APP_TITLE,
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Failed to load OpenRouter model catalog: ${response.status}`,
    );
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
    const pricing = parseOpenRouterPricing(model?.pricing, "openrouter");
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

    const push = (
      kind: CatalogModelKind,
      extra: Partial<CatalogModelCandidate> = {},
    ) => {
      if (
        !kindAllowed(kind, input.kinds) ||
        !providerSupportsKind(input.gateway, kind)
      ) {
        return;
      }
      if (
        (kind === "chat" || kind === "vision") &&
        !supportedParameters.includes("tools")
      ) {
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

// OrcaRouter tags every text endpoint "openai", so a TTS model is
// indistinguishable from chat by `supported_endpoint_types` — only the id
// carries the signal (openai/tts-1, gpt-4o-mini-tts, gemini-*-tts, ...).
const ORCAROUTER_TTS_PATTERN = /(^|[/-])tts(-|$)/;

/**
 * Model capabilities for an aggregator come from the normalized model catalog
 * (models.dev + LiteLLM + overrides), not the provider's own thin `/v1/models`.
 * Map the neutral shape onto the catalog-candidate fields.
 */
export type CapabilityResolver = (
  modelId: string,
  opts?: { provider?: string },
) => NormalizedModelInfo | null;

function candidateCapabilityFields(info: NormalizedModelInfo | null) {
  const supportedParameters: string[] = [];
  if (info?.toolCall) {
    supportedParameters.push("tools", "tool_choice");
  }
  if (info?.structuredOutput) {
    supportedParameters.push("response_format");
  }
  if (info?.reasoning) {
    supportedParameters.push("reasoning_effort");
  }
  return {
    supportedParameters,
    supportedEfforts: info?.reasoningEfforts ?? [],
    vision: info?.vision === true,
    modality: info?.modality,
  };
}

async function discoverOrcaRouterCatalog(input: {
  gateway: CatalogDiscoveryGateway;
  kinds?: Set<CatalogModelKind>;
  resolve: CapabilityResolver;
}) {
  const response = await createLlmFetch(
    llmEndpointPolicy([input.gateway.baseUrl]),
  )(`${normalizeBaseUrl(input.gateway.baseUrl)}/models`, {
    headers: {
      ...(input.gateway.defaultHeaders ?? {}),
      ...buildAuthHeaders(input.gateway),
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Failed to load OrcaRouter model catalog: ${response.status}`,
    );
  }

  const payload = (await response.json()) as { data?: unknown };
  const data = Array.isArray(payload.data) ? payload.data : [];
  const items: CatalogModelCandidate[] = [];

  for (const rawModel of data) {
    const model = toObjectRecord(rawModel);
    const modelId = typeof model?.id === "string" ? model.id.trim() : "";
    // OrcaRouter's catalog lists each model twice: a provider-prefixed
    // canonical id (`openai/gpt-5.6-luna`, carries `name`) and a bare alias
    // (`gpt-5.6-luna`, no `name`). Keep only prefixed ids so a model surfaces
    // once — same filter OpenRouter discovery uses. OrcaRouter's own pseudo
    // models (`orcarouter/auto`, `orcarouter/fusion`) are prefixed and kept.
    if (!modelId || !modelId.includes("/")) {
      continue;
    }

    const architecture = toObjectRecord(model?.architecture) ?? {};
    const topProvider = toObjectRecord(model?.top_provider);
    const endpointTypes = toStringArray(model?.supported_endpoint_types);
    const inputModalities = toStringArray(architecture.input_modalities);
    const outputModalities = toStringArray(architecture.output_modalities);
    const hasImageInput = inputModalities.includes("image");
    // Text-only endpoints (chat, tts, embeddings) leave output_modalities empty
    // in this catalog; treat "unset" as text so they are not silently dropped.
    const hasTextOutput =
      outputModalities.length === 0 || outputModalities.includes("text");

    // Capabilities (reasoning / tools / vision) and modality come from the
    // normalized catalog (models.dev + LiteLLM + overrides), matched by id.
    // Pricing and context stay from OrcaRouter's own inline catalog — fresher,
    // and present for models the catalog hasn't indexed yet. Routing slugs
    // (orcarouter/auto) and under-described media models are defined in
    // model-overrides.json by exact id.
    const info = input.resolve(modelId, {
      provider: input.gateway.providerName,
    });
    const { supportedParameters, supportedEfforts, vision, modality } =
      candidateCapabilityFields(info);
    // Vision: OrcaRouter's own architecture is authoritative; fall back to the
    // catalog's vision flag only when the OrcaRouter catalog omits modalities.
    const hasVisionInput = hasImageInput || vision;

    // Modality: OrcaRouter's catalog signals, plus the catalog `modality` as one
    // more source for models OrcaRouter under-describes (e.g.
    // grok/grok-imagine-image, served over a chat endpoint with no
    // output_modalities but defined modality:"image" in overrides).
    const isEmbedding =
      endpointTypes.includes("embeddings") || modality === "embedding";
    const isImage =
      endpointTypes.includes("image-generation") ||
      outputModalities.includes("image") ||
      modality === "image";
    const isVideo =
      endpointTypes.includes("openai-video") ||
      outputModalities.includes("video") ||
      modality === "video";
    const isTts = ORCAROUTER_TTS_PATTERN.test(modelId.toLowerCase());

    const displayName =
      typeof model?.name === "string" && model.name.trim().length > 0
        ? model.name.trim()
        : modelId;
    const common = {
      architecture,
      contextLength:
        toFiniteNumber(model?.context_length) ??
        toFiniteNumber(topProvider?.context_length),
      displayName,
      maxCompletionTokens:
        toFiniteNumber(model?.max_completion_tokens) ??
        toFiniteNumber(topProvider?.max_completion_tokens),
      modelId,
      // OrcaRouter's catalog pricing uses the same prompt/completion keys as
      // OpenRouter. Runtime billing uses the provider adapter's opt-in
      // per-request cost/receipt; this catalog value remains an estimate.
      pricing: parseOpenRouterPricing(model?.pricing, "orcarouter"),
      providerCatalogGatewaySlug: input.gateway.slug,
      providerCatalogSource: "orcarouter-models",
      supportedParameters,
      ...(supportedEfforts.length > 0 ? { supportedEfforts } : {}),
    };

    const push = (
      kind: CatalogModelKind,
      extra: Partial<CatalogModelCandidate> = {},
    ) => {
      if (
        !kindAllowed(kind, input.kinds) ||
        !providerSupportsKind(input.gateway, kind)
      ) {
        return;
      }
      items.push({ ...common, kind, ...extra });
    };

    if (isVideo) {
      continue;
    }
    if (isImage) {
      push("image");
      continue;
    }
    if (isEmbedding) {
      push("embedding");
      continue;
    }
    if (isTts) {
      push("tts");
      continue;
    }
    if (hasTextOutput) {
      if (hasVisionInput) {
        push("vision", { supportsImageInput: true });
      }
      push("chat");
    }
  }

  return items;
}

/**
 * Bare openai-compatible discovery: the provider's `/models` gives only ids, so
 * capabilities AND pricing come from the normalized catalog. This is for
 * providers whose `/models` carries no inline pricing.
 *
 * If a provider's `/models` DOES return its own pricing, do NOT route it here —
 * its price is authoritative for that route and would be silently replaced by
 * the registry's (often a different provider's) number. Give it a dedicated
 * `catalogFormat` + `discoverXCatalog` that parses the inline price and prefers
 * it (registry only as fallback), the way `discoverOrcaRouterCatalog` does.
 */
async function discoverOpenAICompatibleCatalog(input: {
  gateway: CatalogDiscoveryGateway;
  kinds?: Set<CatalogModelKind>;
  resolve: CapabilityResolver;
}) {
  const response = await createLlmFetch(
    llmEndpointPolicy([input.gateway.baseUrl]),
  )(`${normalizeBaseUrl(input.gateway.baseUrl)}/models`, {
    headers: {
      ...(input.gateway.defaultHeaders ?? {}),
      ...buildAuthHeaders(input.gateway),
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Failed to load model catalog: ${response.status}`);
  }

  const ids = parseOpenAIModelIds(await response.json());
  const items: CatalogModelCandidate[] = [];
  for (const modelId of ids) {
    const item = buildCandidateFromRegistry({
      gateway: input.gateway,
      modelId,
      source: `${input.gateway.providerKind}-models`,
      resolve: input.resolve,
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
  /** Override the capability resolver (tests inject a fixture registry). */
  resolveCapabilities?: CapabilityResolver;
}) {
  const kinds =
    input.kinds && input.kinds.length > 0 ? new Set(input.kinds) : undefined;

  // OpenRouter is the one provider-self path: its /models carries capabilities.
  if (input.gateway.providerKind === "openrouter") {
    return discoverOpenRouterCatalog({ gateway: input.gateway, kinds });
  }

  // Everything else resolves capabilities from the normalized catalog. OrcaRouter
  // parses rich inline pricing/modality; a plain openai-compatible provider is
  // just bare ids. Both take capabilities from the registry.
  const resolve =
    input.resolveCapabilities ??
    ((id: string, opts?: { provider?: string }) =>
      modelCatalog.resolve(id, opts));

  if (input.gateway.catalogFormat === "orcarouter") {
    return discoverOrcaRouterCatalog({
      gateway: input.gateway,
      kinds,
      resolve,
    });
  }

  return discoverOpenAICompatibleCatalog({
    gateway: input.gateway,
    kinds,
    resolve,
  });
}

export async function discoverByokModelCandidates(input: {
  fetch: typeof globalThis.fetch;
  providerKind: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  apiKeyHeaderName?: string;
  apiKeyHeaderPrefix?: string;
  defaultHeaders?: Record<string, string>;
}) {
  const gateway: CatalogDiscoveryGateway = {
    slug: `byok-${input.providerName}`,
    providerKind: input.providerKind,
    providerName: input.providerName,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    apiKeyHeaderName: input.apiKeyHeaderName,
    apiKeyHeaderPrefix: input.apiKeyHeaderPrefix,
    defaultHeaders: input.defaultHeaders,
    supports: ["chat", "embeddings", "rerank", "asr", "image", "tool_calling"],
  };
  const response = await input.fetch(
    `${normalizeBaseUrl(gateway.baseUrl)}/models`,
    {
      headers: {
        ...(gateway.defaultHeaders ?? {}),
        ...buildAuthHeaders(gateway),
      },
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Failed to load BYOK model catalog: ${response.status}`);
  }

  return parseOpenAIModelIds(await response.json()).map((modelId) => ({
    modelId,
    displayName: modelId,
  }));
}
