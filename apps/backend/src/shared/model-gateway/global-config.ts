import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  ProviderRoutingConfig,
  ProviderRoutingSort,
} from "@sourceweft/model-gateway";

export type GlobalGatewayEntry = {
  slug: string;
  baseUrl: string;
  baseUrlEnv?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  apiKeyHeaderName?: string;
  apiKeyHeaderPrefix?: string;
  defaultHeaders: Record<string, string>;
  providerName: string;
  providerKind:
    | "openai-compatible"
    | "openrouter"
    | "deepinfra"
    | "siliconflow-cn"
    | "openai"
    | "anthropic"
    | "gemini"
    | "azure-openai";
  supports: string[];
  timeoutMs?: number;
  maxRetries?: number;
  isDefault: boolean;
  isActive: boolean;
  isBYOK: boolean;
  modelCatalog?: {
    enabled: boolean;
    kinds?: Array<
      "chat" | "rerank" | "embedding" | "asr" | "tts" | "vision" | "image" | "video"
    >;
  };
};

export type GlobalProfilePricingEntry = {
  source?: "manual" | "openrouter" | "litellm";
  litellmKey?: string | null;
  inputCostPerToken?: number | null;
  outputCostPerToken?: number | null;
  cacheReadInputTokenCost?: number | null;
  cacheCreationInputTokenCost?: number | null;
  outputCostPerReasoningToken?: number | null;
  inputCostPerImageToken?: number | null;
  outputCostPerImageToken?: number | null;
  inputCostPerAudioToken?: number | null;
  outputCostPerAudioToken?: number | null;
  inputCostPerImage?: number | null;
  outputCostPerImage?: number | null;
};

export type GlobalModelProfileEntry = {
  profileId?: string;
  profileAlias: string;
  modelAlias: string;
  gatewaySlug: string;
  providerName: string;
  targetModel: string;
  routingStrategy:
    | "priority"
    | "weighted-random"
    | "least-latency"
    | "cost-aware"
    | "sticky-by-tenant";
  priority: number;
  weight: number;
  isDefault: boolean;
  isActive: boolean;
  pricing?: GlobalProfilePricingEntry | null;
  supportedParameters?: string[];
  supportedEfforts?: Array<"minimal" | "low" | "medium" | "high" | "xhigh">;
  providerRouting?: ProviderRoutingConfig;
  imageGeneration?: Record<string, unknown>;
};

export type GlobalEmbeddingProfileEntry = {
  profileId?: string;
  profileAlias: string;
  gatewaySlug: string;
  providerName: string;
  modelAlias: string;
  targetModel: string;
  routingStrategy:
    | "priority"
    | "weighted-random"
    | "least-latency"
    | "cost-aware"
    | "sticky-by-tenant";
  priority: number;
  weight: number;
  requestedDimensions: number | null;
  vectorStrategy: "auto" | "exact" | "disabled";
  isDefault: boolean;
  isActive: boolean;
  pricing?: GlobalProfilePricingEntry | null;
};

export type GlobalModelGatewayConfig = {
  versionHash: string;
  sourceJson: Record<string, unknown>;
  gateways: GlobalGatewayEntry[];
  chatProfiles: GlobalModelProfileEntry[];
  imageProfiles: GlobalModelProfileEntry[];
  visionProfiles: GlobalModelProfileEntry[];
  rerankProfiles: GlobalModelProfileEntry[];
  asrProfiles: GlobalModelProfileEntry[];
  ttsProfiles: GlobalModelProfileEntry[];
  embeddingProfiles: GlobalEmbeddingProfileEntry[];
};

type RawGlobalGatewayEntry = {
  slug?: unknown;
  baseUrl?: unknown;
  baseUrlEnv?: unknown;
  apiKeyEnv?: unknown;
  apiKeyHeaderName?: unknown;
  apiKeyHeaderPrefix?: unknown;
  defaultHeaders?: unknown;
  providerName?: unknown;
  providerKind?: unknown;
  supports?: unknown;
  timeoutMs?: unknown;
  maxRetries?: unknown;
  isDefault?: unknown;
  isActive?: unknown;
  isBYOK?: unknown;
  modelCatalog?: unknown;
};

type RawGlobalModelProfileEntry = {
  profileId?: unknown;
  profileAlias?: unknown;
  modelAlias?: unknown;
  gatewaySlug?: unknown;
  providerName?: unknown;
  targetModel?: unknown;
  routingStrategy?: unknown;
  priority?: unknown;
  weight?: unknown;
  isDefault?: unknown;
  isActive?: unknown;
  pricing?: unknown;
  supportedParameters?: unknown;
  supportedEfforts?: unknown;
  providerRouting?: unknown;
  imageGeneration?: unknown;
};

const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
const PROVIDER_ROUTING_SORT_BY = ["price", "throughput", "latency"] as const;
const PROVIDER_ROUTING_SORT_PARTITIONS = ["model", "none"] as const;
const MODEL_CATALOG_KINDS = [
  "chat",
  "rerank",
  "embedding",
  "asr",
  "tts",
  "vision",
  "image",
  "video",
] as const;

function asModelCatalogKinds(value: unknown, field: string) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Invalid global model gateway config field: ${field}`);
  }

  return Array.from(
    new Set(
      value.map((item, index) => {
        if (typeof item !== "string") {
          throw new Error(`Invalid global model gateway config field: ${field}[${index}]`);
        }
        const normalized = item.trim().toLowerCase();
        if (!MODEL_CATALOG_KINDS.includes(normalized as (typeof MODEL_CATALOG_KINDS)[number])) {
          throw new Error(`Invalid global model gateway config field: ${field}[${index}]`);
        }
        return normalized as (typeof MODEL_CATALOG_KINDS)[number];
      }),
    ),
  );
}

function asReasoningEffortArray(value: unknown, field: string) {
  if (value === undefined || value === null) {
    return [] as Array<(typeof REASONING_EFFORTS)[number]>;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Invalid global model gateway config field: ${field}`);
  }

  return Array.from(
    new Set(
      value.map((item, index) => {
        if (typeof item !== "string") {
          throw new Error(`Invalid global model gateway config field: ${field}[${index}]`);
        }
        const normalized = item.trim().toLowerCase();
        if (!REASONING_EFFORTS.includes(normalized as (typeof REASONING_EFFORTS)[number])) {
          throw new Error(`Invalid global model gateway config field: ${field}[${index}]`);
        }
        return normalized as (typeof REASONING_EFFORTS)[number];
      }),
    ),
  );
}

function asOptionalReasoningEffortArray(value: unknown, field: string) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return asReasoningEffortArray(value, field);
}

type RawGlobalEmbeddingProfileEntry = {
  profileId?: unknown;
  profileAlias?: unknown;
  gatewaySlug?: unknown;
  providerName?: unknown;
  modelAlias?: unknown;
  targetModel?: unknown;
  routingStrategy?: unknown;
  priority?: unknown;
  weight?: unknown;
  requestedDimensions?: unknown;
  vectorStrategy?: unknown;
  isDefault?: unknown;
  isActive?: unknown;
  pricing?: unknown;
};

type RawGlobalModelGatewayConfig = {
  _comment?: unknown;
  gateways?: unknown;
  chatProfiles?: unknown;
  imageProfiles?: unknown;
  visionProfiles?: unknown;
  rerankProfiles?: unknown;
  asrProfiles?: unknown;
  ttsProfiles?: unknown;
  embeddingProfiles?: unknown;
};

function asNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid global model gateway config field: ${fieldName}`);
  }

  return value.trim();
}

function asOptionalEnvName(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Invalid global model gateway config field: ${fieldName}`);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeConfigBaseUrl(value: string, fieldName: string) {
  try {
    return new URL(value).toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`Invalid global model gateway config field: ${fieldName}`);
  }
}

function asOptionalPositiveNumber(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid global model gateway config field: ${fieldName}`);
  }

  return Math.floor(value);
}

function asOptionalNonNegativeNumber(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid global model gateway config field: ${fieldName}`);
  }

  return Math.floor(value);
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value !== "boolean") {
    return fallback;
  }

  return value;
}

function asStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Invalid global model gateway config field: ${fieldName}`);
  }

  return value.map((item, index) =>
    asNonEmptyString(item, `${fieldName}[${index}]`),
  );
}

function asOptionalStringArray(value: unknown, fieldName: string) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return asStringArray(value, fieldName);
}

function asProviderRoutingSort(
  value: unknown,
  fieldName: string,
): ProviderRoutingSort | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (
      !PROVIDER_ROUTING_SORT_BY.includes(
        normalized as (typeof PROVIDER_ROUTING_SORT_BY)[number],
      )
    ) {
      throw new Error(`Invalid global model gateway config field: ${fieldName}`);
    }
    return normalized as (typeof PROVIDER_ROUTING_SORT_BY)[number];
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid global model gateway config field: ${fieldName}`);
  }

  const record = value as Record<string, unknown>;
  const by = typeof record.by === "string" ? record.by.trim().toLowerCase() : "";
  if (
    !PROVIDER_ROUTING_SORT_BY.includes(
      by as (typeof PROVIDER_ROUTING_SORT_BY)[number],
    )
  ) {
    throw new Error(`Invalid global model gateway config field: ${fieldName}.by`);
  }

  const partition =
    record.partition === undefined || record.partition === null
      ? "model"
      : typeof record.partition === "string"
        ? record.partition.trim().toLowerCase()
        : "";
  if (
    !PROVIDER_ROUTING_SORT_PARTITIONS.includes(
      partition as (typeof PROVIDER_ROUTING_SORT_PARTITIONS)[number],
    )
  ) {
    throw new Error(
      `Invalid global model gateway config field: ${fieldName}.partition`,
    );
  }

  return {
    by: by as (typeof PROVIDER_ROUTING_SORT_BY)[number],
    partition: partition as (typeof PROVIDER_ROUTING_SORT_PARTITIONS)[number],
  };
}

function asOptionalProviderRouting(
  value: unknown,
  fieldName: string,
): ProviderRoutingConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid global model gateway config field: ${fieldName}`);
  }

  const record = value as Record<string, unknown>;
  const only =
    record.only === undefined || record.only === null
      ? undefined
      : asStringArray(record.only, `${fieldName}.only`);
  if (only !== undefined && only.length === 0) {
    throw new Error(`Invalid global model gateway config field: ${fieldName}.only`);
  }

  const sort = asProviderRoutingSort(record.sort, `${fieldName}.sort`);
  if (only === undefined && sort === undefined) {
    throw new Error(`Invalid global model gateway config field: ${fieldName}`);
  }

  return {
    ...(only !== undefined ? { only } : {}),
    ...(sort !== undefined ? { sort } : {}),
  };
}

function asStringRecord(value: unknown, fieldName: string): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid global model gateway config field: ${fieldName}`);
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, headerValue]) => {
      if (typeof headerValue !== "string") {
        throw new Error(`Invalid global model gateway config field: ${fieldName}.${key}`);
      }

      const headerName = key.trim();
      const normalizedValue = headerValue.trim();
      if (!headerName || !normalizedValue) {
        throw new Error(`Invalid global model gateway config field: ${fieldName}.${key}`);
      }

      return [headerName, normalizedValue] as const;
    }),
  );
}

function asRoutingStrategy(
  value: unknown,
  fieldName: string,
):
  | "priority"
  | "weighted-random"
  | "least-latency"
  | "cost-aware"
  | "sticky-by-tenant" {
  if (
    value === "priority" ||
    value === "weighted-random" ||
    value === "least-latency" ||
    value === "cost-aware" ||
    value === "sticky-by-tenant"
  ) {
    return value;
  }

  if (value === undefined || value === null) {
    return "priority";
  }

  throw new Error(`Invalid global model gateway config field: ${fieldName}`);
}

function asProviderKind(
  value: unknown,
  fieldName: string,
):
  | "openai-compatible"
  | "openrouter"
  | "deepinfra"
  | "siliconflow-cn"
  | "openai"
  | "anthropic"
  | "gemini"
  | "azure-openai" {
  if (
    value === "openai-compatible" ||
    value === "openrouter" ||
    value === "deepinfra" ||
    value === "siliconflow-cn" ||
    value === "openai" ||
    value === "anthropic" ||
    value === "gemini" ||
    value === "azure-openai"
  ) {
    return value;
  }

  throw new Error(`Invalid global model gateway config field: ${fieldName}`);
}

function asOptionalNullableString(
  value: unknown,
  fieldName: string,
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid global model gateway config field: ${fieldName}`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePriceNumber(value: number): number {
  return Number(value.toPrecision(15));
}

function asOptionalNullableNumber(
  value: unknown,
  fieldName: string,
): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid global model gateway config field: ${fieldName}`);
  }
  return normalizePriceNumber(value);
}

function parsePricingEntry(
  value: unknown,
  fieldName: string,
): GlobalProfilePricingEntry | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid global model gateway config field: ${fieldName}`);
  }

  const record = value as Record<string, unknown>;
  const parsed: GlobalProfilePricingEntry = {};

  parsed.litellmKey = asOptionalNullableString(
    record.litellmKey,
    `${fieldName}.litellmKey`,
  );
  parsed.inputCostPerToken = asOptionalNullableNumber(
    record.inputCostPerToken,
    `${fieldName}.inputCostPerToken`,
  );
  parsed.outputCostPerToken = asOptionalNullableNumber(
    record.outputCostPerToken,
    `${fieldName}.outputCostPerToken`,
  );
  parsed.cacheReadInputTokenCost = asOptionalNullableNumber(
    record.cacheReadInputTokenCost,
    `${fieldName}.cacheReadInputTokenCost`,
  );
  parsed.cacheCreationInputTokenCost = asOptionalNullableNumber(
    record.cacheCreationInputTokenCost,
    `${fieldName}.cacheCreationInputTokenCost`,
  );
  parsed.outputCostPerReasoningToken = asOptionalNullableNumber(
    record.outputCostPerReasoningToken,
    `${fieldName}.outputCostPerReasoningToken`,
  );
  parsed.inputCostPerImageToken = asOptionalNullableNumber(
    record.inputCostPerImageToken,
    `${fieldName}.inputCostPerImageToken`,
  );
  parsed.outputCostPerImageToken = asOptionalNullableNumber(
    record.outputCostPerImageToken,
    `${fieldName}.outputCostPerImageToken`,
  );
  parsed.inputCostPerAudioToken = asOptionalNullableNumber(
    record.inputCostPerAudioToken,
    `${fieldName}.inputCostPerAudioToken`,
  );
  parsed.outputCostPerAudioToken = asOptionalNullableNumber(
    record.outputCostPerAudioToken,
    `${fieldName}.outputCostPerAudioToken`,
  );
  parsed.inputCostPerImage = asOptionalNullableNumber(
    record.inputCostPerImage,
    `${fieldName}.inputCostPerImage`,
  );
  parsed.outputCostPerImage = asOptionalNullableNumber(
    record.outputCostPerImage,
    `${fieldName}.outputCostPerImage`,
  );

  return parsed;
}

function parseGatewayEntry(
  entry: RawGlobalGatewayEntry,
  index: number,
): GlobalGatewayEntry {
  const baseUrlEnv = asOptionalEnvName(
    entry.baseUrlEnv,
    `gateways[${index}].baseUrlEnv`,
  );
  const apiKeyEnv =
    typeof entry.apiKeyEnv === "string" && entry.apiKeyEnv.trim().length > 0
      ? entry.apiKeyEnv.trim()
      : undefined;
  const apiKeyHeaderName =
    typeof entry.apiKeyHeaderName === "string" &&
      entry.apiKeyHeaderName.trim().length > 0
      ? entry.apiKeyHeaderName.trim()
      : undefined;
  const apiKeyHeaderPrefix =
    typeof entry.apiKeyHeaderPrefix === "string"
      ? entry.apiKeyHeaderPrefix
      : undefined;
  const baseUrlOverride = baseUrlEnv ? process.env[baseUrlEnv]?.trim() : "";
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv]?.trim() : "";

  const slug = asNonEmptyString(entry.slug, `gateways[${index}].slug`);
  const baseUrl = baseUrlOverride
    ? normalizeConfigBaseUrl(
        baseUrlOverride,
        `gateways[${index}].baseUrlEnv:${baseUrlEnv}`,
      )
    : normalizeConfigBaseUrl(
        asNonEmptyString(entry.baseUrl, `gateways[${index}].baseUrl`),
        `gateways[${index}].baseUrl`,
      );

  const modelCatalog =
    entry.modelCatalog && typeof entry.modelCatalog === "object" &&
      !Array.isArray(entry.modelCatalog)
      ? {
          enabled: asBoolean(
            (entry.modelCatalog as Record<string, unknown>).enabled,
            false,
          ),
          kinds: asModelCatalogKinds(
            (entry.modelCatalog as Record<string, unknown>).kinds,
            `gateways[${index}].modelCatalog.kinds`,
          ),
        }
      : undefined;

  return {
    slug,
    baseUrl,
    baseUrlEnv,
    apiKey: apiKey || undefined,
    apiKeyEnv,
    apiKeyHeaderName,
    apiKeyHeaderPrefix,
    defaultHeaders: asStringRecord(
      entry.defaultHeaders,
      `gateways[${index}].defaultHeaders`,
    ),
    providerName:
      typeof entry.providerName === "string" && entry.providerName.trim().length > 0
        ? entry.providerName.trim()
        : slug,
    providerKind: asProviderKind(
      entry.providerKind ?? "openai-compatible",
      `gateways[${index}].providerKind`,
    ),
    supports: asStringArray(entry.supports, `gateways[${index}].supports`),
    timeoutMs: asOptionalPositiveNumber(
      entry.timeoutMs,
      `gateways[${index}].timeoutMs`,
    ),
    maxRetries: asOptionalNonNegativeNumber(
      entry.maxRetries,
      `gateways[${index}].maxRetries`,
    ),
    isDefault: asBoolean(entry.isDefault, false),
    isActive: asBoolean(entry.isActive, true),
    isBYOK: asBoolean(entry.isBYOK, false),
    ...(modelCatalog ? { modelCatalog } : {}),
  };
}

function parseModelProfileEntry(
  entry: RawGlobalModelProfileEntry,
  index: number,
  field:
    | "chatProfiles"
    | "imageProfiles"
    | "visionProfiles"
    | "rerankProfiles"
    | "asrProfiles"
    | "ttsProfiles",
): GlobalModelProfileEntry {
  const modelAlias = asNonEmptyString(
    entry.modelAlias,
    `${field}[${index}].modelAlias`,
  );

  const pricing = parsePricingEntry(entry.pricing, `${field}[${index}].pricing`);
  const supportedParameters = asOptionalStringArray(
    entry.supportedParameters,
    `${field}[${index}].supportedParameters`,
  );
  const supportedEfforts = asOptionalReasoningEffortArray(
    entry.supportedEfforts,
    `${field}[${index}].supportedEfforts`,
  );
  const providerRouting = asOptionalProviderRouting(
    entry.providerRouting,
    `${field}[${index}].providerRouting`,
  );

  return {
    profileId:
      typeof entry.profileId === "string" && entry.profileId.trim().length > 0
        ? entry.profileId.trim()
        : undefined,
    profileAlias:
      typeof entry.profileAlias === "string" && entry.profileAlias.trim().length > 0
        ? entry.profileAlias.trim()
        : modelAlias,
    modelAlias,
    gatewaySlug: asNonEmptyString(
      entry.gatewaySlug,
      `${field}[${index}].gatewaySlug`,
    ),
    providerName:
      typeof entry.providerName === "string" && entry.providerName.trim().length > 0
        ? entry.providerName.trim()
        : modelAlias,
    targetModel:
      typeof entry.targetModel === "string" && entry.targetModel.trim().length > 0
        ? entry.targetModel.trim()
        : modelAlias,
    routingStrategy: asRoutingStrategy(
      entry.routingStrategy,
      `${field}[${index}].routingStrategy`,
    ),
    priority: asOptionalPositiveNumber(
      entry.priority,
      `${field}[${index}].priority`,
    ) ?? 1,
    weight: asOptionalNonNegativeNumber(
      entry.weight,
      `${field}[${index}].weight`,
    ) ?? 0,
    isDefault: asBoolean(entry.isDefault, false),
    isActive: asBoolean(entry.isActive, true),
    ...(pricing !== undefined ? { pricing } : {}),
    ...(supportedParameters !== undefined ? { supportedParameters } : {}),
    ...(supportedEfforts !== undefined ? { supportedEfforts } : {}),
    ...(providerRouting !== undefined ? { providerRouting } : {}),
    imageGeneration:
      entry.imageGeneration &&
      typeof entry.imageGeneration === "object" &&
      !Array.isArray(entry.imageGeneration)
        ? (entry.imageGeneration as Record<string, unknown>)
        : undefined,
  };
}

function parseEmbeddingProfileEntry(
  entry: RawGlobalEmbeddingProfileEntry,
  index: number,
): GlobalEmbeddingProfileEntry {
  let requestedDimensions: number | null = null;
  if (
    entry.requestedDimensions !== undefined &&
    entry.requestedDimensions !== null
  ) {
    if (
      typeof entry.requestedDimensions !== "number" ||
      !Number.isInteger(entry.requestedDimensions) ||
      entry.requestedDimensions <= 0
    ) {
      throw new Error(
        `Invalid global model gateway config field: embeddingProfiles[${index}].requestedDimensions`,
      );
    }
    requestedDimensions = entry.requestedDimensions;
  }

  const vectorStrategy =
    entry.vectorStrategy === "exact" ||
    entry.vectorStrategy === "disabled" ||
    entry.vectorStrategy === "auto"
      ? entry.vectorStrategy
      : "auto";

  const modelAlias = asNonEmptyString(
    entry.modelAlias,
    `embeddingProfiles[${index}].modelAlias`,
  );

  return {
    profileId:
      typeof entry.profileId === "string" && entry.profileId.trim().length > 0
        ? entry.profileId.trim()
        : undefined,
    profileAlias: asNonEmptyString(
      entry.profileAlias,
      `embeddingProfiles[${index}].profileAlias`,
    ),
    gatewaySlug: asNonEmptyString(
      entry.gatewaySlug,
      `embeddingProfiles[${index}].gatewaySlug`,
    ),
    providerName:
      typeof entry.providerName === "string" && entry.providerName.trim().length > 0
        ? entry.providerName.trim()
        : modelAlias,
    modelAlias,
    targetModel:
      typeof entry.targetModel === "string" && entry.targetModel.trim().length > 0
        ? entry.targetModel.trim()
        : modelAlias,
    routingStrategy: asRoutingStrategy(
      entry.routingStrategy,
      `embeddingProfiles[${index}].routingStrategy`,
    ),
    priority: asOptionalPositiveNumber(
      entry.priority,
      `embeddingProfiles[${index}].priority`,
    ) ?? 1,
    weight: asOptionalNonNegativeNumber(
      entry.weight,
      `embeddingProfiles[${index}].weight`,
    ) ?? 0,
    requestedDimensions,
    vectorStrategy,
    isDefault: asBoolean(entry.isDefault, false),
    isActive: asBoolean(entry.isActive, true),
    ...(entry.pricing !== undefined
      ? {
          pricing: parsePricingEntry(
            entry.pricing,
            `embeddingProfiles[${index}].pricing`,
          ),
        }
      : {}),
  };
}

function assertSingleDefault<T extends { isDefault: boolean; isActive: boolean }>(
  items: T[],
  field: string,
) {
  const defaultCount = items.filter(
    (item) => item.isDefault && item.isActive,
  ).length;
  if (defaultCount !== 1) {
    throw new Error(
      `Global model gateway config requires exactly one active default in '${field}', got ${defaultCount}`,
    );
  }
}

function createVersionHash(input: {
  rawContent: string;
  gateways: readonly GlobalGatewayEntry[];
}): string {
  const resolvedBaseUrls = input.gateways.map((gateway) => ({
    baseUrl: gateway.baseUrl,
    baseUrlEnv: gateway.baseUrlEnv ?? null,
    slug: gateway.slug,
  }));

  return createHash("sha256")
    .update(input.rawContent)
    .update("\n")
    .update(JSON.stringify({ resolvedBaseUrls }))
    .digest("hex");
}

function parseGlobalModelGatewayConfig(
  raw: RawGlobalModelGatewayConfig,
  rawContent: string,
): GlobalModelGatewayConfig {
  if (!Array.isArray(raw.gateways) || raw.gateways.length === 0) {
    throw new Error(
      "Global model gateway config requires a non-empty 'gateways' array",
    );
  }

  if (!Array.isArray(raw.chatProfiles) || raw.chatProfiles.length === 0) {
    throw new Error(
      "Global model gateway config requires a non-empty 'chatProfiles' array",
    );
  }

  if (
    !Array.isArray(raw.embeddingProfiles) ||
    raw.embeddingProfiles.length === 0
  ) {
    throw new Error(
      "Global model gateway config requires a non-empty 'embeddingProfiles' array",
    );
  }

  const gateways = raw.gateways.map((entry, index) =>
    parseGatewayEntry(entry as RawGlobalGatewayEntry, index),
  );
  const gatewaySlugSet = new Set<string>();
  const providerNameSet = new Set<string>();
  for (const gateway of gateways) {
    if (gatewaySlugSet.has(gateway.slug)) {
      throw new Error(
        `Global model gateway config has duplicate gateway slug '${gateway.slug}'`,
      );
    }
    if (providerNameSet.has(gateway.providerName)) {
      throw new Error(
        `Global model gateway config has duplicate providerName '${gateway.providerName}'`,
      );
    }
    gatewaySlugSet.add(gateway.slug);
    providerNameSet.add(gateway.providerName);
  }

  const chatProfiles = raw.chatProfiles.map((entry, index) =>
    parseModelProfileEntry(
      entry as RawGlobalModelProfileEntry,
      index,
      "chatProfiles",
    ),
  );
  const imageProfiles = Array.isArray(raw.imageProfiles)
    ? raw.imageProfiles.map((entry, index) =>
        parseModelProfileEntry(
          entry as RawGlobalModelProfileEntry,
          index,
          "imageProfiles",
        ),
      )
    : [];
  const visionProfiles = Array.isArray(raw.visionProfiles)
    ? raw.visionProfiles.map((entry, index) =>
        parseModelProfileEntry(
          entry as RawGlobalModelProfileEntry,
          index,
          "visionProfiles",
        ),
      )
    : [];
  const rerankProfiles = Array.isArray(raw.rerankProfiles)
    ? raw.rerankProfiles.map((entry, index) =>
        parseModelProfileEntry(
          entry as RawGlobalModelProfileEntry,
          index,
          "rerankProfiles",
        ),
      )
    : [];
  const asrProfiles = Array.isArray(raw.asrProfiles)
    ? raw.asrProfiles.map((entry, index) =>
        parseModelProfileEntry(
          entry as RawGlobalModelProfileEntry,
          index,
          "asrProfiles",
        ),
      )
    : [];
  const ttsProfiles = Array.isArray(raw.ttsProfiles)
    ? raw.ttsProfiles.map((entry, index) =>
        parseModelProfileEntry(
          entry as RawGlobalModelProfileEntry,
          index,
          "ttsProfiles",
        ),
      )
    : [];
  const embeddingProfiles = raw.embeddingProfiles.map((entry, index) =>
    parseEmbeddingProfileEntry(entry as RawGlobalEmbeddingProfileEntry, index),
  );

  const profileAliasSet = new Set<string>();
  for (const profile of [
    ...chatProfiles,
    ...imageProfiles,
    ...visionProfiles,
    ...rerankProfiles,
    ...asrProfiles,
    ...ttsProfiles,
    ...embeddingProfiles,
  ]) {
    if (profileAliasSet.has(profile.profileAlias)) {
      throw new Error(
        `Global model gateway config has duplicate profileAlias '${profile.profileAlias}'`,
      );
    }
    profileAliasSet.add(profile.profileAlias);
  }

  for (const profile of [
    ...chatProfiles,
    ...imageProfiles,
    ...visionProfiles,
    ...rerankProfiles,
    ...asrProfiles,
    ...ttsProfiles,
    ...embeddingProfiles,
  ]) {
    if (!gatewaySlugSet.has(profile.gatewaySlug)) {
      throw new Error(
        `Global model gateway config references unknown gatewaySlug '${profile.gatewaySlug}'`,
      );
    }
    if (!providerNameSet.has(profile.providerName)) {
      throw new Error(
        `Global model gateway config references unknown providerName '${profile.providerName}'`,
      );
    }
  }

  assertSingleDefault(gateways, "gateways");
  assertSingleDefault(chatProfiles, "chatProfiles");
  if (imageProfiles.length > 0) {
    assertSingleDefault(imageProfiles, "imageProfiles");
  }
  if (visionProfiles.length > 0) {
    assertSingleDefault(visionProfiles, "visionProfiles");
  }
  if (rerankProfiles.length > 0) {
    assertSingleDefault(rerankProfiles, "rerankProfiles");
  }
  if (asrProfiles.length > 0) {
    assertSingleDefault(asrProfiles, "asrProfiles");
  }
  if (ttsProfiles.length > 0) {
    assertSingleDefault(ttsProfiles, "ttsProfiles");
  }
  assertSingleDefault(embeddingProfiles, "embeddingProfiles");

  return {
    versionHash: createVersionHash({ rawContent, gateways }),
    sourceJson: {
      ...(raw as Record<string, unknown>),
      _resolvedGatewayBaseUrls: gateways.map((gateway) => ({
        baseUrl: gateway.baseUrl,
        baseUrlEnv: gateway.baseUrlEnv ?? null,
        slug: gateway.slug,
      })),
    },
    gateways,
    chatProfiles,
    imageProfiles,
    visionProfiles,
    rerankProfiles,
    asrProfiles,
    ttsProfiles,
    embeddingProfiles,
  };
}

export async function loadGlobalModelGatewayConfig(
  configPath: string,
): Promise<GlobalModelGatewayConfig | null> {
  const normalizedPath = configPath.trim();
  if (!normalizedPath) {
    return null;
  }

  const rawContent = await readFile(normalizedPath, "utf8");
  const parsed = JSON.parse(rawContent) as RawGlobalModelGatewayConfig;
  return parseGlobalModelGatewayConfig(parsed, rawContent);
}
