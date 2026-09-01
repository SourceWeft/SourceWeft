import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  ModelCapabilityRule,
  ProviderRoutingConfig,
  ProviderRoutingSort,
} from "@sourceweft/model-gateway";
import type {
  ModelGatewayProviderKind,
  ModelGatewayRoutingStrategy,
} from "@sourceweft/db";

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
  providerKind: ModelGatewayProviderKind;
  supports: string[];
  timeoutMs?: number;
  maxRetries?: number;
  isDefault: boolean;
  activation: {
    env: string;
    source: "env" | "default";
    enabled: boolean;
    configured: boolean;
    globalReady: boolean;
  };
  isBYOK: boolean;
  modelCatalog?: {
    enabled: boolean;
    kinds?: Array<
      | "chat"
      | "rerank"
      | "embedding"
      | "asr"
      | "tts"
      | "vision"
      | "image"
      | "video"
    >;
    /**
     * Optional discovery-format override. Defaults to the provider-kind's
     * generic OpenAI `/models` shape (id-only, priced from LiteLLM). Set to
     * "orcarouter" to parse OrcaRouter's richer catalog (inline pricing,
     * `supported_endpoint_types`, `architecture`) — reused across an
     * openai-compatible provider without a first-class provider kind.
     */
    format?: "orcarouter";
  };
};

export type GlobalProfilePricingEntry = {
  source?: "manual" | "openrouter" | "orcarouter" | "litellm";
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

/**
 * One execution target behind a profile alias. The alias is the product-facing
 * model — it carries the price the user is charged — while targets are the
 * interchangeable places we can actually run it. Config files may still write a
 * single target inline (`gatewaySlug`/`targetModel`/... on the entry itself);
 * `parseProfileTargets` folds that form into a one-element array so nothing
 * downstream has to know both shapes exist.
 */
export type GlobalProfileTarget = {
  gatewaySlug: string;
  providerName: string;
  targetModel: string;
  priority: number;
  weight: number;
  providerRouting?: ProviderRoutingConfig;
};

export type GlobalModelProfileEntry = {
  profileId?: string;
  profileAlias: string;
  modelAlias: string;
  /** Ordered by ascending priority; `targets[0]` is the primary target. */
  targets: GlobalProfileTarget[];
  routingStrategy: ModelGatewayRoutingStrategy;
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
  modelAlias: string;
  /**
   * Always exactly one target: two embedding models behind one alias would mix
   * incompatible vector spaces in the same index. `parseEmbeddingProfileEntry`
   * rejects the multi-target form outright.
   */
  targets: GlobalProfileTarget[];
  routingStrategy: ModelGatewayRoutingStrategy;
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
  /**
   * Deployment-declared capability rules (optional override layer). The shipped
   * defaults (model-capability-db.ts) are merged in at runtime, not here, so a
   * code change to them applies on redeploy without a re-sync. Matched by model
   * name at request time — see docs/architecture/model-capabilities.md.
   */
  modelCapabilities: ModelCapabilityRule[];
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
  activation?: unknown;
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
  targets?: unknown;
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

const REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
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
          throw new Error(
            `Invalid global model gateway config field: ${field}[${index}]`,
          );
        }
        const normalized = item.trim().toLowerCase();
        if (
          !MODEL_CATALOG_KINDS.includes(
            normalized as (typeof MODEL_CATALOG_KINDS)[number],
          )
        ) {
          throw new Error(
            `Invalid global model gateway config field: ${field}[${index}]`,
          );
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
          throw new Error(
            `Invalid global model gateway config field: ${field}[${index}]`,
          );
        }
        const normalized = item.trim().toLowerCase();
        if (
          !REASONING_EFFORTS.includes(
            normalized as (typeof REASONING_EFFORTS)[number],
          )
        ) {
          throw new Error(
            `Invalid global model gateway config field: ${field}[${index}]`,
          );
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
  targets?: unknown;
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
  modelCapabilities?: unknown;
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

function asOptionalEnvName(
  value: unknown,
  fieldName: string,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Invalid global model gateway config field: ${fieldName}`);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

function asEnvName(value: unknown, fieldName: string): string {
  const name = asNonEmptyString(value, fieldName);
  if (!ENV_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid global model gateway config field: ${fieldName}`);
  }
  return name;
}

function parseStrictBooleanEnv(input: {
  envName: string;
  fallback: boolean;
  fieldName: string;
}) {
  const rawValue = process.env[input.envName];
  if (rawValue === undefined) {
    return { enabled: input.fallback, source: "default" as const };
  }
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return { enabled: true, source: "env" as const };
  }
  if (normalized === "false" || normalized === "0") {
    return { enabled: false, source: "env" as const };
  }
  throw new Error(
    `Invalid global model gateway activation env ${input.envName} for ${input.fieldName}: expected true, false, 1, or 0`,
  );
}

function parseGatewayActivation(
  entry: RawGlobalGatewayEntry,
  index: number,
  configured: boolean,
): GlobalGatewayEntry["activation"] {
  if (entry.isActive !== undefined) {
    throw new Error(
      `Invalid global model gateway config field: gateways[${index}].isActive; use activation`,
    );
  }
  if (
    !entry.activation ||
    typeof entry.activation !== "object" ||
    Array.isArray(entry.activation)
  ) {
    throw new Error(
      `Invalid global model gateway config field: gateways[${index}].activation`,
    );
  }
  const activation = entry.activation as Record<string, unknown>;
  const env = asEnvName(
    activation.env,
    `gateways[${index}].activation.env`,
  );
  if (typeof activation.default !== "boolean") {
    throw new Error(
      `Invalid global model gateway config field: gateways[${index}].activation.default`,
    );
  }
  const resolved = parseStrictBooleanEnv({
    envName: env,
    fallback: activation.default,
    fieldName: `gateways[${index}].activation`,
  });
  return {
    env,
    source: resolved.source,
    enabled: resolved.enabled,
    configured,
    globalReady: resolved.enabled && configured,
  };
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

function asOptionalBoolean(
  value: unknown,
  fieldName: string,
): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Invalid global model gateway config field: ${fieldName}`);
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
      throw new Error(
        `Invalid global model gateway config field: ${fieldName}`,
      );
    }
    return normalized as (typeof PROVIDER_ROUTING_SORT_BY)[number];
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid global model gateway config field: ${fieldName}`);
  }

  const record = value as Record<string, unknown>;
  const by =
    typeof record.by === "string" ? record.by.trim().toLowerCase() : "";
  if (
    !PROVIDER_ROUTING_SORT_BY.includes(
      by as (typeof PROVIDER_ROUTING_SORT_BY)[number],
    )
  ) {
    throw new Error(
      `Invalid global model gateway config field: ${fieldName}.by`,
    );
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
    throw new Error(
      `Invalid global model gateway config field: ${fieldName}.only`,
    );
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

// Resolve `${ENV_NAME}` references in a header value from process.env. This
// keeps deployment-specific header values (e.g. the AI Gateway id) out of the
// committed config, mirroring how `baseUrlEnv` sources the base URL. A literal
// value with no `${...}` reference is returned unchanged.
function resolveHeaderValueEnv(rawValue: string, fieldName: string): string {
  return rawValue.replace(/\$\{([A-Z0-9_]+)\}/gu, (_match, envName: string) => {
    const resolved = process.env[envName]?.trim();
    if (!resolved) {
      throw new Error(
        `Missing environment variable '${envName}' referenced by ${fieldName}`,
      );
    }
    return resolved;
  });
}

function asStringRecord(
  value: unknown,
  fieldName: string,
): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid global model gateway config field: ${fieldName}`);
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(
      ([key, headerValue]) => {
        if (typeof headerValue !== "string") {
          throw new Error(
            `Invalid global model gateway config field: ${fieldName}.${key}`,
          );
        }

        const headerName = key.trim();
        const normalizedValue = resolveHeaderValueEnv(
          headerValue.trim(),
          `${fieldName}.${key}`,
        );
        if (!headerName || !normalizedValue) {
          throw new Error(
            `Invalid global model gateway config field: ${fieldName}.${key}`,
          );
        }

        return [headerName, normalizedValue] as const;
      },
    ),
  );
}

function asRoutingStrategy(
  value: unknown,
  fieldName: string,
): ModelGatewayRoutingStrategy {
  if (value === "priority" || value === "weighted-random") {
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
): ModelGatewayProviderKind {
  if (
    value === "openai-compatible" ||
    value === "cloudflare-aig" ||
    value === "openrouter" ||
    value === "deepinfra" ||
    value === "deepseek" ||
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

const PRICING_COST_FIELDS = [
  "inputCostPerToken",
  "outputCostPerToken",
  "cacheReadInputTokenCost",
  "cacheCreationInputTokenCost",
  "outputCostPerReasoningToken",
  "inputCostPerImageToken",
  "outputCostPerImageToken",
  "inputCostPerAudioToken",
  "outputCostPerAudioToken",
  "inputCostPerImage",
  "outputCostPerImage",
] as const satisfies ReadonlyArray<keyof GlobalProfilePricingEntry>;

/**
 * True when the config states the price itself — either a LiteLLM key to read it
 * from, or at least one cost field — rather than leaving it to alias auto-match.
 */
function hasExplicitPricing(
  pricing: GlobalProfilePricingEntry | null | undefined,
): boolean {
  if (!pricing) {
    return false;
  }
  if (
    typeof pricing.litellmKey === "string" &&
    pricing.litellmKey.trim().length > 0
  ) {
    return true;
  }
  return PRICING_COST_FIELDS.some((name) => typeof pricing[name] === "number");
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
  const activation = parseGatewayActivation(
    entry,
    index,
    apiKeyEnv ? Boolean(apiKey) : true,
  );

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
    entry.modelCatalog &&
    typeof entry.modelCatalog === "object" &&
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
          ...((entry.modelCatalog as Record<string, unknown>).format ===
          "orcarouter"
            ? { format: "orcarouter" as const }
            : {}),
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
      typeof entry.providerName === "string" &&
      entry.providerName.trim().length > 0
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
    activation,
    isBYOK: asBoolean(entry.isBYOK, false),
    ...(modelCatalog ? { modelCatalog } : {}),
  };
}

const INLINE_TARGET_FIELDS = [
  "gatewaySlug",
  "providerName",
  "targetModel",
  "priority",
  "weight",
] as const;

function parseModelCapabilities(value: unknown): ModelCapabilityRule[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(
      "Invalid global model gateway config field: modelCapabilities",
    );
  }
  return value.map((raw, index) => {
    const field = `modelCapabilities[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Invalid global model gateway config field: ${field}`);
    }
    const record = raw as Record<string, unknown>;
    const capabilities = record.capabilities;
    if (
      !capabilities ||
      typeof capabilities !== "object" ||
      Array.isArray(capabilities)
    ) {
      throw new Error(
        `Invalid global model gateway config field: ${field}.capabilities`,
      );
    }
    const caps = capabilities as Record<string, unknown>;
    const disabledParams = parseDisabledParams(
      caps.disabledParams,
      `${field}.capabilities.disabledParams`,
    );
    const toolCallArgumentJsonRepair = asOptionalBoolean(
      caps.toolCallArgumentJsonRepair,
      `${field}.capabilities.toolCallArgumentJsonRepair`,
    );
    const structuredOutputMethod = asOptionalStructuredOutputMethod(
      caps.structuredOutputMethod,
      `${field}.capabilities.structuredOutputMethod`,
    );
    return {
      modelMatch: asNonEmptyString(record.modelMatch, `${field}.modelMatch`),
      capabilities: {
        ...(disabledParams !== undefined ? { disabledParams } : {}),
        ...(toolCallArgumentJsonRepair !== undefined
          ? { toolCallArgumentJsonRepair }
          : {}),
        ...(structuredOutputMethod !== undefined
          ? { structuredOutputMethod }
          : {}),
      },
    };
  });
}

/**
 * Validate a disabled_params map (langchain-python `disabled_params` mirror):
 * each value must be `null` (drop the param entirely) or an array (drop only
 * those values). Returns undefined when absent.
 */
function parseDisabledParams(
  value: unknown,
  field: string,
): Record<string, null | readonly unknown[]> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid global model gateway config field: ${field}`);
  }
  const out: Record<string, null | readonly unknown[]> = {};
  for (const [param, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (entry !== null && !Array.isArray(entry)) {
      throw new Error(
        `Invalid global model gateway config field: ${field}.${param}`,
      );
    }
    out[param] = entry as null | readonly unknown[];
  }
  return out;
}

function asOptionalStructuredOutputMethod(
  value: unknown,
  field: string,
): "json_schema" | "json_mode" | "function_calling" | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    value !== "json_schema" &&
    value !== "json_mode" &&
    value !== "function_calling"
  ) {
    throw new Error(`Invalid global model gateway config field: ${field}`);
  }
  return value;
}

function parseProfileTarget(input: {
  raw: Record<string, unknown>;
  field: string;
  modelAlias: string;
}): GlobalProfileTarget {
  const providerRouting = asOptionalProviderRouting(
    input.raw.providerRouting,
    `${input.field}.providerRouting`,
  );

  return {
    gatewaySlug: asNonEmptyString(
      input.raw.gatewaySlug,
      `${input.field}.gatewaySlug`,
    ),
    providerName:
      typeof input.raw.providerName === "string" &&
      input.raw.providerName.trim().length > 0
        ? input.raw.providerName.trim()
        : input.modelAlias,
    targetModel:
      typeof input.raw.targetModel === "string" &&
      input.raw.targetModel.trim().length > 0
        ? input.raw.targetModel.trim()
        : input.modelAlias,
    priority:
      asOptionalPositiveNumber(input.raw.priority, `${input.field}.priority`) ??
      1,
    weight:
      asOptionalNonNegativeNumber(input.raw.weight, `${input.field}.weight`) ??
      0,
    ...(providerRouting !== undefined ? { providerRouting } : {}),
  };
}

/**
 * Folds both accepted file shapes into one internal shape. Either the entry
 * carries a single target inline, or it carries a `targets` array — mixing the
 * two is rejected rather than resolved by precedence, so a config can never
 * silently mean something other than it looks like.
 */
function parseProfileTargets(input: {
  entry: { targets?: unknown } & Record<string, unknown>;
  field: string;
  modelAlias: string;
}): GlobalProfileTarget[] {
  const { entry, field, modelAlias } = input;

  if (entry.targets === undefined || entry.targets === null) {
    return [parseProfileTarget({ raw: entry, field, modelAlias })];
  }

  const conflicting = INLINE_TARGET_FIELDS.filter(
    (name) => entry[name] !== undefined && entry[name] !== null,
  );
  if (conflicting.length > 0) {
    throw new Error(
      `Global model gateway config entry '${field}' sets both 'targets' and inline target fields (${conflicting.join(
        ", ",
      )}); use one form or the other`,
    );
  }

  if (!Array.isArray(entry.targets) || entry.targets.length === 0) {
    throw new Error(
      `Invalid global model gateway config field: ${field}.targets`,
    );
  }

  const targets = entry.targets.map((raw, targetIndex) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        `Invalid global model gateway config field: ${field}.targets[${targetIndex}]`,
      );
    }
    return parseProfileTarget({
      raw: raw as Record<string, unknown>,
      field: `${field}.targets[${targetIndex}]`,
      modelAlias,
    });
  });

  const seen = new Set<string>();
  for (const target of targets) {
    const key = `${target.gatewaySlug}\u0000${target.targetModel}`;
    if (seen.has(key)) {
      throw new Error(
        `Global model gateway config entry '${field}' repeats target '${target.gatewaySlug}/${target.targetModel}'`,
      );
    }
    seen.add(key);
  }

  return [...targets].sort((left, right) => left.priority - right.priority);
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

  const pricing = parsePricingEntry(
    entry.pricing,
    `${field}[${index}].pricing`,
  );
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
  const targets = parseProfileTargets({
    entry: entry as Record<string, unknown>,
    field: `${field}[${index}]`,
    modelAlias,
  });

  // A single alias spanning several providers needs an explicit price-book
  // fallback. Providers that report actual cost bypass it at runtime; targets
  // without actual-cost reporting use this alias price rather than an inferred
  // price from whichever route happened to be primary during sync.
  if (targets.length > 1 && !hasExplicitPricing(pricing)) {
    throw new Error(
      `Global model gateway config entry '${field}[${index}]' declares multiple targets and must set an explicit 'pricing' block or 'pricing.litellmKey'`,
    );
  }

  return {
    profileId:
      typeof entry.profileId === "string" && entry.profileId.trim().length > 0
        ? entry.profileId.trim()
        : undefined,
    profileAlias:
      typeof entry.profileAlias === "string" &&
      entry.profileAlias.trim().length > 0
        ? entry.profileAlias.trim()
        : modelAlias,
    modelAlias,
    targets,
    routingStrategy: asRoutingStrategy(
      entry.routingStrategy,
      `${field}[${index}].routingStrategy`,
    ),
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

  if (entry.targets !== undefined && entry.targets !== null) {
    throw new Error(
      `Global model gateway config entry 'embeddingProfiles[${index}]' cannot declare multiple targets: embeddings behind one alias must stay on a single model to keep one vector space`,
    );
  }

  return {
    profileId:
      typeof entry.profileId === "string" && entry.profileId.trim().length > 0
        ? entry.profileId.trim()
        : undefined,
    profileAlias: asNonEmptyString(
      entry.profileAlias,
      `embeddingProfiles[${index}].profileAlias`,
    ),
    modelAlias,
    targets: parseProfileTargets({
      entry: entry as Record<string, unknown>,
      field: `embeddingProfiles[${index}]`,
      modelAlias,
    }),
    routingStrategy: asRoutingStrategy(
      entry.routingStrategy,
      `embeddingProfiles[${index}].routingStrategy`,
    ),
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

function assertSingleGatewayDefault(
  gateways: GlobalGatewayEntry[],
  field: string,
) {
  const defaultCount = gateways.filter((gateway) => gateway.isDefault).length;
  if (defaultCount !== 1) {
    throw new Error(
      `Global model gateway config requires exactly one default in '${field}', got ${defaultCount}`,
    );
  }
}

function createVersionHash(input: {
  rawContent: string;
  gateways: readonly GlobalGatewayEntry[];
}): string {
  const resolvedGateways = input.gateways.map((gateway) => ({
    baseUrl: gateway.baseUrl,
    baseUrlEnv: gateway.baseUrlEnv ?? null,
    activation: gateway.activation,
    slug: gateway.slug,
  }));

  return createHash("sha256")
    .update(input.rawContent)
    .update("\n")
    .update(JSON.stringify({ resolvedGateways }))
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
    for (const target of profile.targets) {
      if (!gatewaySlugSet.has(target.gatewaySlug)) {
        throw new Error(
          `Global model gateway config references unknown gatewaySlug '${target.gatewaySlug}'`,
        );
      }
      if (!providerNameSet.has(target.providerName)) {
        throw new Error(
          `Global model gateway config references unknown providerName '${target.providerName}'`,
        );
      }
    }
  }

  assertSingleGatewayDefault(gateways, "gateways");
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

  // Deployment override rules only; the shipped defaults are merged at runtime
  // (runtime.ts) so a code-DB change applies on redeploy without a re-sync.
  const modelCapabilities = parseModelCapabilities(raw.modelCapabilities);

  return {
    versionHash: createVersionHash({ rawContent, gateways }),
    sourceJson: {
      ...(raw as Record<string, unknown>),
      _resolvedGateways: gateways.map((gateway) => ({
        baseUrl: gateway.baseUrl,
        baseUrlEnv: gateway.baseUrlEnv ?? null,
        activation: gateway.activation,
        slug: gateway.slug,
      })),
    },
    gateways,
    modelCapabilities,
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
