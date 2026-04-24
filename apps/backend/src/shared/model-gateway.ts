import { randomUUID } from "node:crypto";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import {
  createLangChainChatModel,
  createModelGateway,
  type LangChainModelExecutionConfig,
  type ModelGateway,
  type ModelGatewayConfig,
} from "@sourceweft/model-gateway";
import { and, eq, ne, sql } from "drizzle-orm";
import { config } from "./config";
import { db } from "./database";
import {
  modelGatewayConfigVersions,
  modelGatewayConfigs,
  modelGatewayByokKeyRefs,
  modelGatewayProviderConfigs,
  modelGatewayRoutes,
  modelGatewayProfiles,
} from "./db/schema";
import type { ModelPricing } from "./db/schema-types";
import { logger } from "./logger";
import {
  type GlobalProfilePricingEntry,
  loadGlobalModelGatewayConfig,
} from "./model-gateway-global-config";
import { createDatabaseObserveSink } from "./model-gateway-observe";
import { decryptSecret, encryptSecret } from "./secrets";
import { syncModelPricing } from "./scripts/sync-model-pricing";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const GLOBAL_MODEL_GATEWAY_CONFIG_RELATIVE_PATH = "../../config/model-gateway.global.json";
const OPENROUTER_MODELS_API_URL = "https://openrouter.ai/api/v1/models";
const DYNAMIC_OPENROUTER_PROFILE_PREFIX = "global-openrouter";
const OPENROUTER_APP_TITLE = "SourceWeft";
const OPENROUTER_APP_REFERER = "https://SourceWeft.com";

type ModelGatewayProfileKind =
  | "chat"
  | "rerank"
  | "embedding"
  | "asr"
  | "tts"
  | "vision"
  | "image"
  | "video";

type ModelGatewayProfileRow = typeof modelGatewayProfiles.$inferSelect;

type RuntimeModelGatewayProfile = {
  id: string;
  kind: ModelGatewayProfileKind;
  gatewayConfigId: string;
  profileAlias: string;
  modelAlias: string;
  requestedDimensions: number | null;
  vectorStrategy: "auto" | "exact" | "disabled";
  isDefault: boolean;
  isActive: boolean;
  configJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type ActiveConfigVersionRow = typeof modelGatewayConfigVersions.$inferSelect;

type DynamicOpenRouterProfileEntry = {
  displayName: string;
  profileAlias: string;
  targetModel: string;
};

type DynamicOpenRouterProfilesByKind = {
  chat: DynamicOpenRouterProfileEntry[];
  image: DynamicOpenRouterProfileEntry[];
  vision: DynamicOpenRouterProfileEntry[];
};

function normalizeDefaultHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, headerValue]) => [key.trim(), headerValue.trim()] as const)
      .filter(([key, headerValue]) => key.length > 0 && headerValue.length > 0),
  );
}

function withOpenRouterAttributionHeaders(input: {
  providerKind:
    | "openai-compatible"
    | "openrouter"
    | "deepinfra"
    | "openai"
    | "anthropic"
    | "gemini"
    | "azure-openai";
  defaultHeaders?: Record<string, string>;
}) {
  const headers = {
    ...(input.defaultHeaders ?? {}),
  };

  if (input.providerKind !== "openrouter") {
    return headers;
  }

  return {
    ...headers,
    "X-Title": OPENROUTER_APP_TITLE,
    "HTTP-Referer": OPENROUTER_APP_REFERER,
  };
}

function normalizeCatalogSlug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.length > 0 ? normalized : "model";
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

async function fetchDynamicOpenRouterProfiles(): Promise<DynamicOpenRouterProfilesByKind> {
  const empty: DynamicOpenRouterProfilesByKind = {
    chat: [],
    image: [],
    vision: [],
  };

  try {
    const response = await fetch(OPENROUTER_MODELS_API_URL, {
      headers: {
        "User-Agent": "sourceweft-model-gateway/1.0",
        "X-Title": OPENROUTER_APP_TITLE,
        "HTTP-Referer": OPENROUTER_APP_REFERER,
      },
    });
    if (!response.ok) {
      logger.warn("Failed to load OpenRouter model catalog", {
        status: response.status,
      });
      return empty;
    }

    const payload = (await response.json()) as { data?: unknown };
    if (!payload?.data || !Array.isArray(payload.data)) {
      return empty;
    }

    const byKind: DynamicOpenRouterProfilesByKind = {
      chat: [],
      image: [],
      vision: [],
    };

    for (const rawModel of payload.data) {
      if (!rawModel || typeof rawModel !== "object") {
        continue;
      }

      const model = rawModel as Record<string, unknown>;
      const modelId = typeof model.id === "string" ? model.id.trim() : "";
      if (!modelId || !modelId.includes("/")) {
        continue;
      }

      const name = typeof model.name === "string" && model.name.trim().length > 0
        ? model.name.trim()
        : modelId;

      const architecture =
        model.architecture && typeof model.architecture === "object"
          ? (model.architecture as Record<string, unknown>)
          : {};
      const inputModalities = toStringArray(architecture.input_modalities);
      const outputModalities = toStringArray(architecture.output_modalities);

      const hasImageInput = inputModalities.includes("image");
      const hasTextOutput = outputModalities.includes("text");
      const hasImageOutput = outputModalities.includes("image");

      const slug = normalizeCatalogSlug(modelId);
      const encodedModelId = encodeURIComponent(modelId);
      const asEntry = (kind: "chat" | "image" | "vision") => ({
        displayName: name,
        // Keep profileAlias internal for sync identity, expose modelAlias as real model id.
        profileAlias: `${DYNAMIC_OPENROUTER_PROFILE_PREFIX}-${kind}-${slug}-${encodedModelId}`,
        targetModel: modelId,
      });

      if (hasImageOutput) {
        byKind.image.push(asEntry("image"));
      }

      if (hasImageInput && hasTextOutput && !hasImageOutput) {
        byKind.vision.push(asEntry("vision"));
      }

      if (hasTextOutput && !hasImageOutput) {
        byKind.chat.push(asEntry("chat"));
      }
    }

    const sorter = (
      left: DynamicOpenRouterProfileEntry,
      right: DynamicOpenRouterProfileEntry,
    ) => left.displayName.localeCompare(right.displayName);

    byKind.chat.sort(sorter);
    byKind.image.sort(sorter);
    byKind.vision.sort(sorter);

    return byKind;
  } catch (error) {
    logger.warn("Failed to fetch OpenRouter models", {
      error: error instanceof Error ? error.message : String(error),
    });
    return empty;
  }
}

function buildProfilePricingConfigJson(
  pricing: GlobalProfilePricingEntry | null | undefined,
  now: Date,
): Record<string, unknown> {
  const hasManualPrice =
    pricing?.inputCostPerToken !== undefined ||
    pricing?.outputCostPerToken !== undefined ||
    pricing?.cacheReadInputTokenCost !== undefined ||
    pricing?.cacheCreationInputTokenCost !== undefined ||
    pricing?.outputCostPerReasoningToken !== undefined;

  if (hasManualPrice) {
    const manualPricing: ModelPricing = {
      input_cost_per_token: pricing?.inputCostPerToken ?? null,
      output_cost_per_token: pricing?.outputCostPerToken ?? null,
      cache_read_input_token_cost: pricing?.cacheReadInputTokenCost ?? null,
      cache_creation_input_token_cost: pricing?.cacheCreationInputTokenCost ?? null,
      output_cost_per_reasoning_token: pricing?.outputCostPerReasoningToken ?? null,
      price_source: "manual",
      litellm_key: pricing?.litellmKey ?? null,
      price_updated_at: now.toISOString(),
    };
    return manualPricing as unknown as Record<string, unknown>;
  }

  if (pricing?.litellmKey) {
    const presetPricing: ModelPricing = {
      input_cost_per_token: null,
      output_cost_per_token: null,
      cache_read_input_token_cost: null,
      cache_creation_input_token_cost: null,
      output_cost_per_reasoning_token: null,
      price_source: "litellm",
      litellm_key: pricing.litellmKey,
      price_updated_at: null,
    };
    return presetPricing as unknown as Record<string, unknown>;
  }

  const unknownPricing: ModelPricing = {
    input_cost_per_token: null,
    output_cost_per_token: null,
    cache_read_input_token_cost: null,
    cache_creation_input_token_cost: null,
    output_cost_per_reasoning_token: null,
    price_source: "unknown",
    litellm_key: null,
    price_updated_at: null,
  };
  return unknownPricing as unknown as Record<string, unknown>;
}
type RoutedGatewayConfig = {
  versionId: string;
  providers: Record<
    string,
    {
      gatewayConfigId: string | null;
      kind:
        | "openai-compatible"
        | "openrouter"
        | "deepinfra"
        | "openai"
        | "anthropic"
        | "gemini"
        | "azure-openai";
      baseUrl: string;
      apiKey?: string;
      defaultHeaders: Record<string, string>;
      supports: string[];
    }
  >;
  modelRoutes: Record<
    string,
    {
      strategy:
        | "priority"
        | "weighted-random"
        | "least-latency"
        | "cost-aware"
        | "sticky-by-tenant";
      targets: Array<{
        provider: string;
        model: string;
        priority?: number;
        weight?: number;
      }>;
    }
  >;
};

const gatewayClientCache = new Map<
  string,
  {
    signature: string;
    client: ModelGateway;
  }
>();

let modelConfigSyncPromise: Promise<void> | null = null;

const MODEL_GATEWAY_CONFIG_SYNC_LOCK_ID = 7_344_001;

export function resolveGlobalModelGatewayConfigPath() {
  const configuredPath = config.modelGatewayGlobalConfigPath?.trim();
  if (configuredPath) {
    return configuredPath;
  }

  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDirPath = dirname(currentFilePath);
  return resolvePath(currentDirPath, GLOBAL_MODEL_GATEWAY_CONFIG_RELATIVE_PATH);
}

function mapModelGatewayProfile(
  row: ModelGatewayProfileRow,
): RuntimeModelGatewayProfile {
  return {
    id: row.id,
    kind: row.kind,
    gatewayConfigId: row.gatewayConfigId,
    profileAlias: row.profileAlias,
    modelAlias: row.modelAlias,
    requestedDimensions: row.requestedDimensions,
    vectorStrategy: row.vectorStrategy,
    isDefault: row.isDefault,
    isActive: row.isActive,
    configJson: row.configJson ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function resolveByokApiKeyRef(input: {
  provider: string;
  apiKeyRef: string;
  metadata?: Record<string, unknown>;
}) {
  const workspaceId =
    typeof input.metadata?.workspace_id === "string"
      ? input.metadata.workspace_id
      : undefined;
  const teamId =
    typeof input.metadata?.team_id === "string"
      ? input.metadata.team_id
      : undefined;
  const userId =
    typeof input.metadata?.user_id === "string"
      ? input.metadata.user_id
      : undefined;

  if (!workspaceId || !teamId) {
    return null;
  }

  const rows = await db
    .select()
    .from(modelGatewayByokKeyRefs)
    .where(
      and(
        eq(modelGatewayByokKeyRefs.workspaceId, workspaceId),
        eq(modelGatewayByokKeyRefs.teamId, teamId),
        eq(modelGatewayByokKeyRefs.providerName, input.provider),
        eq(modelGatewayByokKeyRefs.keyRef, input.apiKeyRef),
        eq(modelGatewayByokKeyRefs.isActive, true),
      ),
    );

  const row = rows.find((candidate) => {
    if (!candidate.userId) {
      return true;
    }
    return userId ? candidate.userId === userId : false;
  });

  if (!row) {
    return null;
  }

  return (
    decryptSecret(row.apiKeyEncrypted, config.modelGatewayEncryptionSecret) ||
    null
  );
}

async function findActiveConfigVersionRow(): Promise<ActiveConfigVersionRow | null> {
  const [row] = await db
    .select()
    .from(modelGatewayConfigVersions)
    .where(eq(modelGatewayConfigVersions.isActive, true))
    .limit(1);

  return row ?? null;
}

export async function loadRoutedGatewayConfig(): Promise<RoutedGatewayConfig | null> {
  const activeVersion = await findActiveConfigVersionRow();
  if (!activeVersion) {
    return null;
  }

  const providerRows = await db
    .select()
    .from(modelGatewayProviderConfigs)
    .where(
      and(
        eq(modelGatewayProviderConfigs.configVersionId, activeVersion.id),
        eq(modelGatewayProviderConfigs.isActive, true),
      ),
    );

  const routeRows = await db
    .select()
    .from(modelGatewayRoutes)
    .where(
      and(
        eq(modelGatewayRoutes.configVersionId, activeVersion.id),
        eq(modelGatewayRoutes.isActive, true),
      ),
    );

  if (providerRows.length === 0 || routeRows.length === 0) {
    return null;
  }

  const gatewayIds = Array.from(
    new Set(
      providerRows
        .map((row) => row.gatewayConfigId)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  );

  const gatewayRows = gatewayIds.length
    ? (await db.select().from(modelGatewayConfigs)).filter((row) =>
        row.isActive && gatewayIds.includes(row.id),
      )
    : [];
  const gatewayRowById = new Map(gatewayRows.map((row) => [row.id, row]));

  const providers: RoutedGatewayConfig["providers"] = {};
  for (const row of providerRows) {
    const gatewayRow = row.gatewayConfigId ? gatewayRowById.get(row.gatewayConfigId) : null;
    const supports = Array.isArray(row.capabilitiesJson)
      ? row.capabilitiesJson.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : [];

    providers[row.providerName] = {
      gatewayConfigId: row.gatewayConfigId,
      kind: row.providerKind,
      baseUrl: row.baseUrl,
      apiKey:
        gatewayRow && gatewayRow.apiKeyEncrypted
          ? decryptSecret(
              gatewayRow.apiKeyEncrypted,
              config.modelGatewayEncryptionSecret,
            ) || undefined
          : undefined,
      defaultHeaders: withOpenRouterAttributionHeaders({
        providerKind: row.providerKind,
        defaultHeaders: normalizeDefaultHeaders(
          row.configJson && typeof row.configJson === "object"
            ? (row.configJson as Record<string, unknown>).defaultHeaders
            : undefined,
        ),
      }),
      supports,
    };
  }

  const modelRoutes: RoutedGatewayConfig["modelRoutes"] = {};
  for (const row of routeRows) {
    const existing = modelRoutes[row.alias] ?? {
      strategy: row.strategy,
      targets: [],
    };
    existing.targets.push({
      provider: row.targetProviderName,
      model: row.targetModel,
      priority: row.priority,
      weight: row.weight,
    });
    modelRoutes[row.alias] = existing;
  }

  return {
    versionId: activeVersion.id,
    providers,
    modelRoutes,
  };
}

function getRoutedGatewayCacheSignature(config: RoutedGatewayConfig) {
  return JSON.stringify(config);
}

function hasGatewayConfig(
  routedConfig: RoutedGatewayConfig,
  gatewayConfigId: string,
) {
  return Object.values(routedConfig.providers).some(
    (provider) => provider.gatewayConfigId === gatewayConfigId,
  );
}

function assertGatewayConfigAvailable(
  routedConfig: RoutedGatewayConfig,
  gatewayConfigId?: string | null,
) {
  if (!gatewayConfigId) {
    return;
  }

  if (!hasGatewayConfig(routedConfig, gatewayConfigId)) {
    throw new Error(
      `Gateway config '${gatewayConfigId}' is not available in the active model gateway version`,
    );
  }
}

function buildRoutedModelGatewayConfig(
  configInput: RoutedGatewayConfig,
): ModelGatewayConfig {
  return {
    providers: Object.fromEntries(
      Object.entries(configInput.providers).map(([name, provider]) => [
        name,
        {
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          defaultHeaders: provider.defaultHeaders,
          supports: provider.supports,
        },
      ]),
    ),
    modelRoutes: configInput.modelRoutes,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
    allowNonDefaultAliases: true,
    resolveApiKeyRef: resolveByokApiKeyRef,
    observeSink: createDatabaseObserveSink(),
  };
}

function getOrCreateRoutedGatewayClient(configInput: RoutedGatewayConfig) {
  const signature = getRoutedGatewayCacheSignature(configInput);
  const cacheKey = `routed:${configInput.versionId}`;
  const cached = gatewayClientCache.get(cacheKey);
  if (cached && cached.signature === signature) {
    return cached.client;
  }

  const client = createModelGateway(buildRoutedModelGatewayConfig(configInput));

  gatewayClientCache.set(cacheKey, {
    signature,
    client,
  });

  return client;
}

async function findDefaultModelGatewayProfileRow(kind: ModelGatewayProfileKind) {
  const [row] = await db
    .select()
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.kind, kind),
        eq(modelGatewayProfiles.isDefault, true),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);

  return row ?? null;
}

async function upsertModelGatewayProfileFromGlobalConfig(
  kind: ModelGatewayProfileKind,
  entry: {
    profileId?: string;
    profileAlias: string;
    modelAlias: string;
    isDefault: boolean;
    isActive: boolean;
    requestedDimensions?: number | null;
    vectorStrategy?: "auto" | "exact" | "disabled";
    pricing?: GlobalProfilePricingEntry | null;
    displayName?: string;
    subtitle?: string;
    badges?: string[];
  },
  gatewayConfigId: string,
  now: Date,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
) {
  const [existing] = await tx
    .select({ id: modelGatewayProfiles.id })
    .from(modelGatewayProfiles)
    .where(
      entry.profileId
        ? eq(modelGatewayProfiles.id, entry.profileId)
        : eq(modelGatewayProfiles.profileAlias, entry.profileAlias),
    )
    .limit(1);

  const setPayload = {
    kind,
    gatewayConfigId,
    profileAlias: entry.profileAlias,
    modelAlias: entry.modelAlias,
    requestedDimensions: entry.requestedDimensions ?? null,
    vectorStrategy: entry.vectorStrategy ?? "auto",
    isDefault: entry.isDefault,
    isActive: entry.isActive,
    configJson: {
      ...buildProfilePricingConfigJson(entry.pricing, now),
      ...(entry.displayName ? { displayName: entry.displayName } : {}),
      ...(entry.subtitle ? { subtitle: entry.subtitle } : {}),
      ...(entry.badges && entry.badges.length > 0 ? { badges: entry.badges } : {}),
    },
    updatedAt: now,
  };

  if (existing) {
    await tx
      .update(modelGatewayProfiles)
      .set(setPayload)
      .where(eq(modelGatewayProfiles.id, existing.id));
    return;
  }

  await tx.insert(modelGatewayProfiles).values({
    id: entry.profileId ?? randomUUID(),
    ...setPayload,
    createdAt: now,
  });
}

async function syncGlobalModelGatewayConfigFromFile(configPath: string) {
  const loaded = await loadGlobalModelGatewayConfig(configPath);
  if (!loaded) {
    return;
  }

  const openrouterGateway = loaded.gateways.find(
    (entry) => entry.providerKind === "openrouter" && entry.isActive,
  );
  const dynamicOpenRouterProfiles = openrouterGateway
    ? await fetchDynamicOpenRouterProfiles()
    : {
        chat: [],
        image: [],
        vision: [],
      };

  const chatProfilesToSync = [
    ...loaded.chatProfiles,
    ...dynamicOpenRouterProfiles.chat.map((entry) => ({
      profileAlias: entry.profileAlias,
      modelAlias: entry.targetModel,
      gatewaySlug: openrouterGateway?.slug ?? "",
      providerName: openrouterGateway?.providerName ?? "openrouter",
      targetModel: entry.targetModel,
      routingStrategy: "priority" as const,
      priority: 100,
      weight: 100,
      isDefault: false,
      isActive: true,
      pricing: null,
      displayName: entry.displayName,
      subtitle: entry.targetModel,
    })),
  ];
  const imageProfilesToSync = [
    ...loaded.imageProfiles,
    ...dynamicOpenRouterProfiles.image.map((entry) => ({
      profileAlias: entry.profileAlias,
      modelAlias: entry.targetModel,
      gatewaySlug: openrouterGateway?.slug ?? "",
      providerName: openrouterGateway?.providerName ?? "openrouter",
      targetModel: entry.targetModel,
      routingStrategy: "priority" as const,
      priority: 100,
      weight: 100,
      isDefault: false,
      isActive: true,
      pricing: null,
      displayName: entry.displayName,
      subtitle: entry.targetModel,
    })),
  ];
  const visionProfilesToSync = [
    ...loaded.visionProfiles,
    ...dynamicOpenRouterProfiles.vision.map((entry) => ({
      profileAlias: entry.profileAlias,
      modelAlias: entry.targetModel,
      gatewaySlug: openrouterGateway?.slug ?? "",
      providerName: openrouterGateway?.providerName ?? "openrouter",
      targetModel: entry.targetModel,
      routingStrategy: "priority" as const,
      priority: 100,
      weight: 100,
      isDefault: false,
      isActive: true,
      pricing: null,
      displayName: entry.displayName,
      subtitle: entry.targetModel,
    })),
  ];

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${MODEL_GATEWAY_CONFIG_SYNC_LOCK_ID})`);

    await tx
      .update(modelGatewayConfigVersions)
      .set({ isActive: false, updatedAt: now })
      .where(eq(modelGatewayConfigVersions.isActive, true));

    await tx
      .insert(modelGatewayConfigVersions)
      .values({
        id: randomUUID(),
        versionHash: loaded.versionHash,
        sourcePath: configPath,
        isActive: true,
        payloadJson: loaded.sourceJson,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: modelGatewayConfigVersions.versionHash,
        set: {
          sourcePath: configPath,
          isActive: true,
          payloadJson: loaded.sourceJson,
          updatedAt: now,
        },
      });

    const [versionRow] = await tx
      .select({ id: modelGatewayConfigVersions.id })
      .from(modelGatewayConfigVersions)
      .where(eq(modelGatewayConfigVersions.versionHash, loaded.versionHash))
      .limit(1);

    if (!versionRow) {
      throw new Error("Failed to resolve synchronized model gateway config version");
    }

    const configVersionId = versionRow.id;

    await tx
      .delete(modelGatewayProviderConfigs)
      .where(eq(modelGatewayProviderConfigs.configVersionId, configVersionId));
    await tx
      .delete(modelGatewayRoutes)
      .where(eq(modelGatewayRoutes.configVersionId, configVersionId));

    await tx
      .update(modelGatewayConfigs)
      .set({ isDefault: false, updatedAt: now })
      .where(eq(modelGatewayConfigs.isDefault, true));

    const gatewayIdBySlug = new Map<string, string>();
    for (const entry of loaded.gateways) {
      const [existing] = await tx
        .select({ id: modelGatewayConfigs.id })
        .from(modelGatewayConfigs)
        .where(eq(modelGatewayConfigs.slug, entry.slug))
        .limit(1);

      const apiKeyEncrypted = entry.apiKey
        ? encryptSecret(entry.apiKey, config.modelGatewayEncryptionSecret)
        : null;

      const gatewayConfigJson = {
        providerName: entry.providerName,
        providerKind: entry.providerKind,
        supports: entry.supports,
        apiKeySource: entry.apiKeyEnv ?? null,
      } satisfies Record<string, unknown>;

      let gatewayConfigId = existing?.id;
      if (existing) {
        await tx
          .update(modelGatewayConfigs)
          .set({
            slug: entry.slug,
            baseUrl: entry.baseUrl,
            apiKeyEncrypted,
            timeoutMs: entry.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxRetries: entry.maxRetries ?? DEFAULT_MAX_RETRIES,
            isDefault: entry.isDefault,
            isActive: entry.isActive,
            isBYOK: entry.isBYOK,
            configJson: gatewayConfigJson,
            updatedAt: now,
          })
          .where(eq(modelGatewayConfigs.id, existing.id));
      } else {
        gatewayConfigId = randomUUID();
        await tx.insert(modelGatewayConfigs).values({
          id: gatewayConfigId,
          slug: entry.slug,
          baseUrl: entry.baseUrl,
          apiKeyEncrypted,
          timeoutMs: entry.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxRetries: entry.maxRetries ?? DEFAULT_MAX_RETRIES,
          isDefault: entry.isDefault,
          isActive: entry.isActive,
          isBYOK: entry.isBYOK,
          configJson: gatewayConfigJson,
          createdAt: now,
          updatedAt: now,
        });
      }

      if (!gatewayConfigId) {
        throw new Error(`Failed to resolve gateway config id for slug '${entry.slug}'`);
      }

      gatewayIdBySlug.set(entry.slug, gatewayConfigId);
      await tx.insert(modelGatewayProviderConfigs).values({
        id: randomUUID(),
        configVersionId,
        providerName: entry.providerName,
        providerKind: entry.providerKind,
        gatewayConfigId,
        baseUrl: entry.baseUrl,
        apiKeySource: entry.apiKeyEnv ?? null,
        isActive: entry.isActive,
        capabilitiesJson: entry.supports,
        configJson: {
          timeoutMs: entry.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxRetries: entry.maxRetries ?? DEFAULT_MAX_RETRIES,
          isBYOK: entry.isBYOK,
          defaultHeaders: withOpenRouterAttributionHeaders({
            providerKind: entry.providerKind,
          }),
        },
        createdAt: now,
        updatedAt: now,
      });
    }

    await tx
      .update(modelGatewayProfiles)
      .set({ isDefault: false, isActive: false, updatedAt: now })
      .where(eq(modelGatewayProfiles.kind, "chat"));

    for (const entry of chatProfilesToSync) {
      const gatewayConfigId = gatewayIdBySlug.get(entry.gatewaySlug);
      if (!gatewayConfigId) {
        throw new Error(
          `Global model gateway config references missing gateway slug '${entry.gatewaySlug}' for chat profile '${entry.modelAlias}'`,
        );
      }
      await upsertModelGatewayProfileFromGlobalConfig(
        "chat",
        entry,
        gatewayConfigId,
        now,
        tx,
      );
      await tx.insert(modelGatewayRoutes).values({
        id: randomUUID(),
        configVersionId,
        alias: entry.modelAlias,
        routeKind: "chat",
        strategy: entry.routingStrategy,
        targetProviderName: entry.providerName,
        targetModel: entry.targetModel,
        priority: entry.priority,
        weight: entry.weight,
        constraintsJson: {},
        isDefault: entry.isDefault,
        isActive: entry.isActive,
        createdAt: now,
        updatedAt: now,
      });
    }

    await tx
      .update(modelGatewayProfiles)
      .set({ isDefault: false, isActive: false, updatedAt: now })
      .where(eq(modelGatewayProfiles.kind, "image"));

    for (const entry of imageProfilesToSync) {
      const gatewayConfigId = gatewayIdBySlug.get(entry.gatewaySlug);
      if (!gatewayConfigId) {
        throw new Error(
          `Global model gateway config references missing gateway slug '${entry.gatewaySlug}' for image profile '${entry.modelAlias}'`,
        );
      }
      await upsertModelGatewayProfileFromGlobalConfig(
        "image",
        entry,
        gatewayConfigId,
        now,
        tx,
      );
      await tx.insert(modelGatewayRoutes).values({
        id: randomUUID(),
        configVersionId,
        alias: entry.modelAlias,
        routeKind: "image",
        strategy: entry.routingStrategy,
        targetProviderName: entry.providerName,
        targetModel: entry.targetModel,
        priority: entry.priority,
        weight: entry.weight,
        constraintsJson: {},
        isDefault: entry.isDefault,
        isActive: entry.isActive,
        createdAt: now,
        updatedAt: now,
      });
    }

    await tx
      .update(modelGatewayProfiles)
      .set({ isDefault: false, isActive: false, updatedAt: now })
      .where(eq(modelGatewayProfiles.kind, "vision"));

    for (const entry of visionProfilesToSync) {
      const gatewayConfigId = gatewayIdBySlug.get(entry.gatewaySlug);
      if (!gatewayConfigId) {
        throw new Error(
          `Global model gateway config references missing gateway slug '${entry.gatewaySlug}' for vision profile '${entry.modelAlias}'`,
        );
      }
      await upsertModelGatewayProfileFromGlobalConfig(
        "vision",
        entry,
        gatewayConfigId,
        now,
        tx,
      );
      await tx.insert(modelGatewayRoutes).values({
        id: randomUUID(),
        configVersionId,
        alias: entry.modelAlias,
        routeKind: "vision",
        strategy: entry.routingStrategy,
        targetProviderName: entry.providerName,
        targetModel: entry.targetModel,
        priority: entry.priority,
        weight: entry.weight,
        constraintsJson: {},
        isDefault: entry.isDefault,
        isActive: entry.isActive,
        createdAt: now,
        updatedAt: now,
      });
    }

    await tx
      .update(modelGatewayProfiles)
      .set({ isDefault: false, isActive: false, updatedAt: now })
      .where(eq(modelGatewayProfiles.kind, "rerank"));

    for (const entry of loaded.rerankProfiles) {
      const gatewayConfigId = gatewayIdBySlug.get(entry.gatewaySlug);
      if (!gatewayConfigId) {
        throw new Error(
          `Global model gateway config references missing gateway slug '${entry.gatewaySlug}' for rerank profile '${entry.modelAlias}'`,
        );
      }
      await upsertModelGatewayProfileFromGlobalConfig(
        "rerank",
        entry,
        gatewayConfigId,
        now,
        tx,
      );
      await tx.insert(modelGatewayRoutes).values({
        id: randomUUID(),
        configVersionId,
        alias: entry.modelAlias,
        routeKind: "rerank",
        strategy: entry.routingStrategy,
        targetProviderName: entry.providerName,
        targetModel: entry.targetModel,
        priority: entry.priority,
        weight: entry.weight,
        constraintsJson: {},
        isDefault: entry.isDefault,
        isActive: entry.isActive,
        createdAt: now,
        updatedAt: now,
      });
    }

    await tx
      .update(modelGatewayProfiles)
      .set({ isDefault: false, isActive: false, updatedAt: now })
      .where(eq(modelGatewayProfiles.kind, "embedding"));

    for (const entry of loaded.embeddingProfiles) {
      const gatewayConfigId = gatewayIdBySlug.get(entry.gatewaySlug);
      if (!gatewayConfigId) {
        throw new Error(
          `Global model gateway config references missing gateway slug '${entry.gatewaySlug}' for profile '${entry.profileAlias}'`,
        );
      }
      await upsertModelGatewayProfileFromGlobalConfig(
        "embedding",
        entry,
        gatewayConfigId,
        now,
        tx,
      );
      await tx.insert(modelGatewayRoutes).values({
        id: randomUUID(),
        configVersionId,
        alias: entry.modelAlias,
        routeKind: "embedding",
        strategy: entry.routingStrategy,
        targetProviderName: entry.providerName,
        targetModel: entry.targetModel,
        priority: entry.priority,
        weight: entry.weight,
        constraintsJson: {},
        isDefault: entry.isDefault,
        isActive: entry.isActive,
        createdAt: now,
        updatedAt: now,
      });
    }

    await tx
      .delete(modelGatewayProviderConfigs)
      .where(ne(modelGatewayProviderConfigs.configVersionId, configVersionId));

    await tx
      .delete(modelGatewayRoutes)
      .where(ne(modelGatewayRoutes.configVersionId, configVersionId));

  });

  logger.info("Synchronized global model gateway config into DB", {
    path: configPath,
    versionHash: loaded.versionHash,
    gateways: loaded.gateways.length,
    chatProfiles: chatProfilesToSync.length,
    imageProfiles: imageProfilesToSync.length,
    visionProfiles: visionProfilesToSync.length,
    rerankProfiles: loaded.rerankProfiles.length,
    embeddingProfiles: loaded.embeddingProfiles.length,
  });

  try {
    await syncModelPricing();
    logger.info("Triggered immediate model pricing sync after config sync", {
      versionHash: loaded.versionHash,
    });
  } catch (error) {
    logger.error("Immediate model pricing sync after config sync failed", {
      versionHash: loaded.versionHash,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function syncGlobalModelGatewayConfig() {
  if (modelConfigSyncPromise) {
    return modelConfigSyncPromise;
  }

  modelConfigSyncPromise = (async () => {
    const globalConfigPath = resolveGlobalModelGatewayConfigPath();
    await syncGlobalModelGatewayConfigFromFile(globalConfigPath);
  })().catch((error) => {
    modelConfigSyncPromise = null;
    throw error;
  });

  return modelConfigSyncPromise;
}

export async function ensureModelConfigAvailable() {
  const deadline = Date.now() + 30_000;

  while (Date.now() <= deadline) {
    const activeVersion = await findActiveConfigVersionRow();
    if (activeVersion) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    "Global model gateway configuration is not synchronized. Start the scheduler or run the model gateway sync before starting API/worker.",
  );
}

export async function getModelGatewayClient(gatewayConfigId?: string | null) {
  const routedConfig = await loadRoutedGatewayConfig();
  if (!routedConfig) {
    throw new Error("Global model gateway configuration is not synchronized");
  }

  assertGatewayConfigAvailable(routedConfig, gatewayConfigId);

  return getOrCreateRoutedGatewayClient(routedConfig);
}

export async function createAgentChatModel(input: {
  modelAlias: string;
  gatewayConfigId?: string | null;
  execution?: LangChainModelExecutionConfig;
}): Promise<BaseLanguageModel> {
  const routedConfig = await loadRoutedGatewayConfig();
  if (!routedConfig) {
    throw new Error("Global model gateway configuration is not synchronized");
  }

  assertGatewayConfigAvailable(routedConfig, input.gatewayConfigId);

  return createLangChainChatModel({
    modelAlias: input.modelAlias,
    config: buildRoutedModelGatewayConfig(routedConfig),
    execution: input.execution,
  });
}

export async function requireDefaultModelGatewayProfile(kind: ModelGatewayProfileKind) {
  const row = await findDefaultModelGatewayProfileRow(kind);
  if (!row) {
    throw new Error(`Default ${kind} model gateway profile is not configured`);
  }

  return mapModelGatewayProfile(row);
}
