import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type GlobalGatewayEntry = {
  slug: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  providerName: string;
  providerKind:
    | "openai-compatible"
    | "openrouter"
    | "deepinfra"
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
};

export type GlobalProfilePricingEntry = {
  litellmKey?: string | null;
  inputCostPerToken?: number | null;
  outputCostPerToken?: number | null;
  cacheReadInputTokenCost?: number | null;
  cacheCreationInputTokenCost?: number | null;
  outputCostPerReasoningToken?: number | null;
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
  embeddingProfiles: GlobalEmbeddingProfileEntry[];
};

type RawGlobalGatewayEntry = {
  slug?: unknown;
  baseUrl?: unknown;
  apiKeyEnv?: unknown;
  providerName?: unknown;
  providerKind?: unknown;
  supports?: unknown;
  timeoutMs?: unknown;
  maxRetries?: unknown;
  isDefault?: unknown;
  isActive?: unknown;
  isBYOK?: unknown;
};

type RawGlobalModelProfileEntry = {
  profileId?: unknown;
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
};

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
  gateways?: unknown;
  chatProfiles?: unknown;
  imageProfiles?: unknown;
  visionProfiles?: unknown;
  rerankProfiles?: unknown;
  embeddingProfiles?: unknown;
};

function asNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid global model gateway config field: ${fieldName}`);
  }

  return value.trim();
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
  | "openai"
  | "anthropic"
  | "gemini"
  | "azure-openai" {
  if (
    value === "openai-compatible" ||
    value === "openrouter" ||
    value === "deepinfra" ||
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
): GlobalProfilePricingEntry | undefined {
  if (value === undefined || value === null) {
    return undefined;
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

  return parsed;
}

function parseGatewayEntry(
  entry: RawGlobalGatewayEntry,
  index: number,
): GlobalGatewayEntry {
  const apiKeyEnv =
    typeof entry.apiKeyEnv === "string" ? entry.apiKeyEnv.trim() : "";
  const apiKey = apiKeyEnv.length > 0 ? process.env[apiKeyEnv]?.trim() : "";

  if (apiKeyEnv.length > 0 && !apiKey) {
    throw new Error(
      `Missing required env '${apiKeyEnv}' for global model gateway '${String(entry.slug ?? `index-${index}`)}'`,
    );
  }

  const slug = asNonEmptyString(entry.slug, `gateways[${index}].slug`);

  return {
    slug,
    baseUrl: asNonEmptyString(entry.baseUrl, `gateways[${index}].baseUrl`),
    apiKey: apiKey || undefined,
    apiKeyEnv: apiKeyEnv || undefined,
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
  };
}

function parseModelProfileEntry(
  entry: RawGlobalModelProfileEntry,
  index: number,
  field: "chatProfiles" | "imageProfiles" | "visionProfiles" | "rerankProfiles",
): GlobalModelProfileEntry {
  const modelAlias = asNonEmptyString(
    entry.modelAlias,
    `${field}[${index}].modelAlias`,
  );

  return {
    profileId:
      typeof entry.profileId === "string" && entry.profileId.trim().length > 0
        ? entry.profileId.trim()
        : undefined,
    profileAlias: modelAlias,
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
    pricing: parsePricingEntry(entry.pricing, `${field}[${index}].pricing`) ?? null,
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
    pricing: parsePricingEntry(entry.pricing, `embeddingProfiles[${index}].pricing`) ?? null,
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

function createVersionHash(rawContent: string): string {
  return createHash("sha256").update(rawContent).digest("hex");
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

  if (!Array.isArray(raw.rerankProfiles) || raw.rerankProfiles.length === 0) {
    throw new Error(
      "Global model gateway config requires a non-empty 'rerankProfiles' array",
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
  const rerankProfiles = raw.rerankProfiles.map((entry, index) =>
    parseModelProfileEntry(
      entry as RawGlobalModelProfileEntry,
      index,
      "rerankProfiles",
    ),
  );
  const embeddingProfiles = raw.embeddingProfiles.map((entry, index) =>
    parseEmbeddingProfileEntry(entry as RawGlobalEmbeddingProfileEntry, index),
  );

  const modelAliasSet = new Set<string>();
  for (const profile of [
    ...chatProfiles,
    ...imageProfiles,
    ...visionProfiles,
    ...rerankProfiles,
  ]) {
    if (modelAliasSet.has(profile.modelAlias)) {
      throw new Error(
        `Global model gateway config has duplicate modelAlias '${profile.modelAlias}' across model profiles`,
      );
    }
    modelAliasSet.add(profile.modelAlias);
  }

  const profileAliasSet = new Set<string>();
  for (const profile of [
    ...chatProfiles,
    ...imageProfiles,
    ...visionProfiles,
    ...rerankProfiles,
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
  assertSingleDefault(rerankProfiles, "rerankProfiles");
  assertSingleDefault(embeddingProfiles, "embeddingProfiles");

  return {
    versionHash: createVersionHash(rawContent),
    sourceJson: raw as Record<string, unknown>,
    gateways,
    chatProfiles,
    imageProfiles,
    visionProfiles,
    rerankProfiles,
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
