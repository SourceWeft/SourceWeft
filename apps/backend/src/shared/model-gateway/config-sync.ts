import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { config } from "../config";
import {
  db,
  modelGatewayConfigs,
  modelGatewayConfigVersions,
  modelGatewayProfiles,
  modelGatewayProviderConfigs,
  modelGatewayRoutes,
} from "@sourceweft/db";
import { logger } from "../logger";
import {
  type GlobalGatewayEntry,
  type GlobalProfilePricingEntry,
  type GlobalModelProfileEntry,
  loadGlobalModelGatewayConfig,
} from "./global-config";
import { buildProfilePricingConfigJson } from "./profiles";
import {
  resolveModelGatewayMaxRetries,
  resolveModelGatewayTimeoutMs,
  withOpenRouterAttributionHeaders,
} from "./runtime";
import type { ModelGatewayProfileKind } from "./types";
import { encryptSecret } from "../secrets";
import { syncModelPricing } from "./pricing";
import { resolveBackendRuntimePath } from "../runtime-paths";
import {
  discoverGatewayCatalog,
  type CatalogModelCandidate,
} from "./catalog-discovery";
import { fetchLiteLLMPricing, type LiteLLMData } from "./litellm-capabilities";
import {
  stripFormerlyProtectedProfileConfigFields,
  withProtectedProfileConfigFields,
  type ProtectedProfileConfigField,
} from "./profile-config-priority";

let modelConfigSyncPromise: Promise<void> | null = null;

const MODEL_GATEWAY_CONFIG_SYNC_LOCK_ID = 7_344_001;

function assertUniqueProfiles(
  kind: ModelGatewayProfileKind,
  entries: Array<{ modelAlias: string; profileAlias: string }>,
) {
  const profileAliases = new Set<string>();

  for (const entry of entries) {
    if (profileAliases.has(entry.profileAlias)) {
      throw new Error(
        `Global model gateway config resolved duplicate ${kind} profileAlias '${entry.profileAlias}'`,
      );
    }
    profileAliases.add(entry.profileAlias);
  }
}

function assertUniqueRoutes(
  kind: ModelGatewayProfileKind,
  entries: Array<{ profileAlias: string }>,
) {
  const aliases = new Set<string>();
  for (const entry of entries) {
    const alias = entry.profileAlias.trim().toLowerCase();
    if (aliases.has(alias)) {
      throw new Error(
        `Global model gateway config resolved duplicate ${kind} route alias '${entry.profileAlias}'`,
      );
    }
    aliases.add(alias);
  }
}

function buildProfileAliasSet(entries: Array<{ profileAlias: string }>) {
  return new Set(
    entries.map((entry) => entry.profileAlias.trim().toLowerCase()),
  );
}

function hasProfileAlias(entries: Set<string>, profileAlias: string) {
  return entries.has(profileAlias.trim().toLowerCase());
}

export function resolveGlobalModelGatewayConfigPath() {
  return resolveBackendRuntimePath({
    candidates: ["config/model-gateway.global.json"],
    envVar: "MODEL_GATEWAY_GLOBAL_CONFIG_PATH",
    label: "global model gateway config",
  });
}

export function mergeGlobalProfileConfigJson(input: {
  existingConfigJson: Record<string, unknown>;
  entry: {
    pricing?: GlobalProfilePricingEntry | null;
    targetModel: string;
    providerCatalogSource?: string;
    providerCatalogGatewaySlug?: string;
    litellmKey?: string;
    architecture?: Record<string, unknown>;
    supportsImageInput?: boolean;
    contextLength?: number | null;
    defaultParameters?: Record<string, unknown> | null;
    displayName?: string;
    maxCompletionTokens?: number | null;
    subtitle?: string;
    badges?: string[];
    supportedParameters?: string[];
    supportedEfforts?: Array<"minimal" | "low" | "medium" | "high" | "xhigh">;
    providerRouting?: GlobalModelProfileEntry["providerRouting"];
    imageGeneration?: Record<string, unknown>;
  };
  existing: boolean;
  now: Date;
}) {
  const protectedFields: ProtectedProfileConfigField[] = [];
  const pricingConfigJson =
    input.entry.pricing !== undefined || !input.existing
      ? buildProfilePricingConfigJson(input.entry.pricing, input.now)
      : {};
  const globalConfigJson = {
    ...pricingConfigJson,
    targetModel: input.entry.targetModel,
    ...(input.entry.displayName ? { displayName: input.entry.displayName } : {}),
    ...(input.entry.subtitle ? { subtitle: input.entry.subtitle } : {}),
    ...(input.entry.badges && input.entry.badges.length > 0
      ? { badges: input.entry.badges }
      : {}),
    ...(input.entry.providerCatalogSource
      ? { providerCatalogSource: input.entry.providerCatalogSource }
      : {}),
    ...(input.entry.providerCatalogGatewaySlug
      ? { providerCatalogGatewaySlug: input.entry.providerCatalogGatewaySlug }
      : {}),
    ...(input.entry.litellmKey ? { litellm_key: input.entry.litellmKey } : {}),
    ...(input.entry.architecture ? { architecture: input.entry.architecture } : {}),
    ...(input.entry.supportsImageInput ? { supportsImageInput: true } : {}),
    ...(input.entry.contextLength ? { contextLength: input.entry.contextLength } : {}),
    ...(input.entry.defaultParameters
      ? { defaultParameters: input.entry.defaultParameters }
      : {}),
    ...(input.entry.maxCompletionTokens
      ? { maxCompletionTokens: input.entry.maxCompletionTokens }
      : {}),
    ...(input.entry.supportedParameters !== undefined
      ? { supportedParameters: input.entry.supportedParameters }
      : {}),
    ...(input.entry.supportedEfforts !== undefined
      ? { supportedEfforts: input.entry.supportedEfforts }
      : {}),
    ...(input.entry.providerRouting !== undefined
      ? { providerRouting: input.entry.providerRouting }
      : {}),
    ...(input.entry.imageGeneration !== undefined
      ? { imageGeneration: input.entry.imageGeneration }
      : {}),
  };
  if (input.entry.supportedParameters !== undefined) {
    protectedFields.push("supportedParameters");
  }
  if (input.entry.supportedEfforts !== undefined) {
    protectedFields.push("supportedEfforts");
  }
  if (input.entry.imageGeneration !== undefined) {
    protectedFields.push("imageGeneration");
  }
  if (input.entry.providerRouting !== undefined) {
    protectedFields.push("providerRouting");
  }
  if (input.entry.supportsImageInput !== undefined) {
    protectedFields.push("supportsImageInput");
  }
  return withProtectedProfileConfigFields(
    {
      ...stripFormerlyProtectedProfileConfigFields(
        input.existingConfigJson,
        protectedFields,
      ),
      ...globalConfigJson,
    },
    protectedFields,
  );
}

async function upsertModelGatewayProfileFromGlobalConfig(
  kind: ModelGatewayProfileKind,
  entry: {
    profileId?: string;
    profileAlias: string;
    modelAlias: string;
    targetModel: string;
    isDefault: boolean;
    isActive: boolean;
    requestedDimensions?: number | null;
    vectorStrategy?: "auto" | "exact" | "disabled";
    pricing?: GlobalProfilePricingEntry | null;
    providerCatalogSource?: string;
    providerCatalogGatewaySlug?: string;
    litellmKey?: string;
    architecture?: Record<string, unknown>;
    supportsImageInput?: boolean;
    contextLength?: number | null;
    defaultParameters?: Record<string, unknown> | null;
    displayName?: string;
    maxCompletionTokens?: number | null;
    subtitle?: string;
    badges?: string[];
    supportedParameters?: string[];
    supportedEfforts?: Array<"minimal" | "low" | "medium" | "high" | "xhigh">;
    providerRouting?: GlobalModelProfileEntry["providerRouting"];
    imageGeneration?: Record<string, unknown>;
  },
  gatewayConfigId: string,
  now: Date,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
) {
  const [existing] = await tx
    .select({
      id: modelGatewayProfiles.id,
      configJson: modelGatewayProfiles.configJson,
    })
    .from(modelGatewayProfiles)
    .where(
      entry.profileId
        ? eq(modelGatewayProfiles.id, entry.profileId)
        : eq(modelGatewayProfiles.profileAlias, entry.profileAlias),
    )
    .limit(1);

  const existingConfigJson =
    existing?.configJson && typeof existing.configJson === "object"
      ? (existing.configJson as Record<string, unknown>)
      : {};
  const mergedConfigJson = mergeGlobalProfileConfigJson({
    existingConfigJson,
    entry,
    existing: Boolean(existing),
    now,
  });

  const setPayload = {
    kind,
    gatewayConfigId,
    profileAlias: entry.profileAlias,
    modelAlias: entry.modelAlias,
    requestedDimensions: entry.requestedDimensions ?? null,
    vectorStrategy: entry.vectorStrategy ?? "auto",
    isDefault: entry.isDefault,
    isActive: entry.isActive,
    configJson: mergedConfigJson,
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

function dynamicProfileAlias(input: {
  kind: ModelGatewayProfileKind;
  modelId: string;
  providerName: string;
  source: string;
}) {
  const slug = input.modelId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `global-${input.source}-${input.kind}-${slug}-${encodeURIComponent(input.modelId)}`;
}

function toDynamicProfileEntry(input: {
  gateway: GlobalGatewayEntry;
  candidate: CatalogModelCandidate;
}): GlobalModelProfileEntry & {
  architecture?: Record<string, unknown>;
  contextLength?: number | null;
  defaultParameters?: Record<string, unknown> | null;
  displayName?: string;
  kind: ModelGatewayProfileKind;
  maxCompletionTokens?: number | null;
  providerCatalogSource?: string;
  providerCatalogGatewaySlug?: string;
  supportsImageInput?: boolean;
  supportedEfforts?: Array<"minimal" | "low" | "medium" | "high" | "xhigh">;
  supportedParameters?: string[];
  litellmKey?: string;
} {
  return {
    architecture: input.candidate.architecture,
    contextLength: input.candidate.contextLength,
    defaultParameters: input.candidate.defaultParameters,
    displayName: input.candidate.displayName,
    gatewaySlug: input.gateway.slug,
    isActive: true,
    isDefault: false,
    kind: input.candidate.kind,
    litellmKey: input.candidate.litellmKey,
    maxCompletionTokens: input.candidate.maxCompletionTokens,
    modelAlias: input.candidate.modelId,
    pricing: input.candidate.pricing,
    priority: 100,
    profileAlias: dynamicProfileAlias({
      kind: input.candidate.kind,
      modelId: input.candidate.modelId,
      providerName: input.gateway.providerName,
      source: input.candidate.providerCatalogSource,
    }),
    providerCatalogGatewaySlug: input.candidate.providerCatalogGatewaySlug,
    providerCatalogSource: input.candidate.providerCatalogSource,
    providerName: input.gateway.providerName,
    routingStrategy: "priority",
    supportedEfforts: input.candidate.supportedEfforts,
    supportedParameters: input.candidate.supportedParameters,
    supportsImageInput: input.candidate.supportsImageInput,
    targetModel: input.candidate.modelId,
    weight: 100,
  };
}

function groupDynamicProfilesByKind(input: {
  entries: ReturnType<typeof toDynamicProfileEntry>[];
}) {
  const grouped = new Map<ModelGatewayProfileKind, ReturnType<typeof toDynamicProfileEntry>[]>();
  for (const entry of input.entries) {
    const list = grouped.get(entry.kind as ModelGatewayProfileKind) ?? [];
    list.push(entry);
    grouped.set(entry.kind as ModelGatewayProfileKind, list);
  }
  return grouped;
}

async function deactivateMissingStaticProfiles(input: {
  aliases: Set<string>;
  kind: ModelGatewayProfileKind;
  now: Date;
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0];
}) {
  const rows = await input.tx
    .select({
      id: modelGatewayProfiles.id,
      profileAlias: modelGatewayProfiles.profileAlias,
      configJson: modelGatewayProfiles.configJson,
    })
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.kind, input.kind),
        eq(modelGatewayProfiles.isActive, true),
      ),
    );

  const staleIds = rows
    .filter((row) => {
      if (input.aliases.has(row.profileAlias)) {
        return false;
      }
      const configJson =
        row.configJson && typeof row.configJson === "object"
          ? (row.configJson as Record<string, unknown>)
          : {};
      return typeof configJson.providerCatalogSource !== "string";
    })
    .map((row) => row.id);

  for (const id of staleIds) {
    await input.tx
      .update(modelGatewayProfiles)
      .set({ isActive: false, isDefault: false, updatedAt: input.now })
      .where(eq(modelGatewayProfiles.id, id));
  }
}

async function deactivateMissingCatalogProfiles(input: {
  aliases: Set<string>;
  gatewayConfigId: string;
  gatewaySlug: string;
  kind: ModelGatewayProfileKind;
  source: string;
  now: Date;
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0];
}) {
  const rows = await input.tx
    .select({
      id: modelGatewayProfiles.id,
      profileAlias: modelGatewayProfiles.profileAlias,
      configJson: modelGatewayProfiles.configJson,
    })
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.gatewayConfigId, input.gatewayConfigId),
        eq(modelGatewayProfiles.kind, input.kind),
        eq(modelGatewayProfiles.isActive, true),
      ),
    );

  const staleIds = rows
    .filter((row) => {
      const configJson =
        row.configJson && typeof row.configJson === "object"
          ? (row.configJson as Record<string, unknown>)
          : {};
      return (
        configJson.providerCatalogSource === input.source &&
        (configJson.providerCatalogGatewaySlug === input.gatewaySlug ||
          configJson.providerCatalogGatewaySlug === undefined) &&
        !input.aliases.has(row.profileAlias)
      );
    })
    .map((row) => row.id);

  for (const id of staleIds) {
    await input.tx
      .update(modelGatewayProfiles)
      .set({ isActive: false, isDefault: false, updatedAt: input.now })
      .where(eq(modelGatewayProfiles.id, id));
  }
}

async function deactivateCatalogProfilesForGateway(input: {
  gatewayConfigId: string;
  gatewaySlug: string;
  kinds?: Set<ModelGatewayProfileKind>;
  now: Date;
  sources: string[];
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0];
}) {
  const rows = await input.tx
    .select({
      id: modelGatewayProfiles.id,
      kind: modelGatewayProfiles.kind,
      configJson: modelGatewayProfiles.configJson,
    })
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.gatewayConfigId, input.gatewayConfigId),
        eq(modelGatewayProfiles.isActive, true),
      ),
    );

  const sourceSet = new Set(input.sources);
  const staleIds = rows
    .filter((row) => {
      if (input.kinds && !input.kinds.has(row.kind)) {
        return false;
      }
      const configJson =
        row.configJson && typeof row.configJson === "object"
          ? (row.configJson as Record<string, unknown>)
          : {};
      return (
        typeof configJson.providerCatalogSource === "string" &&
        (configJson.providerCatalogGatewaySlug === input.gatewaySlug ||
          configJson.providerCatalogGatewaySlug === undefined) &&
        (sourceSet.size === 0 ||
          sourceSet.has(configJson.providerCatalogSource))
      );
    })
    .map((row) => row.id);

  for (const id of staleIds) {
    await input.tx
      .update(modelGatewayProfiles)
      .set({ isActive: false, isDefault: false, updatedAt: input.now })
      .where(eq(modelGatewayProfiles.id, id));
  }
}

async function loadDynamicCatalogProfiles(input: {
  gateways: GlobalGatewayEntry[];
  litellmData: LiteLLMData | null;
}) {
  let litellmData = input.litellmData;
  const entries: ReturnType<typeof toDynamicProfileEntry>[] = [];
  const successfulCatalogs: Array<{
    gatewaySlug: string;
    source: string;
    kinds: Set<ModelGatewayProfileKind>;
    aliases: Set<string>;
  }> = [];
  const disabledCatalogs: Array<{
    gatewaySlug: string;
    sources: string[];
    kinds?: Set<ModelGatewayProfileKind>;
  }> = [];

  for (const gateway of input.gateways) {
    const catalog = gateway.modelCatalog;
    if (!catalog?.enabled) {
      disabledCatalogs.push({
        gatewaySlug: gateway.slug,
        sources: [`${gateway.providerKind}-models`],
        kinds: catalog?.kinds ? new Set(catalog.kinds) : undefined,
      });
      continue;
    }

    if (gateway.providerKind !== "openrouter" && !litellmData) {
      litellmData = await fetchLiteLLMPricing(config.litellmPricingUrl);
    }

    try {
      const candidates = await discoverGatewayCatalog({
        gateway,
        kinds: catalog.kinds,
        litellmData: litellmData ?? undefined,
      });
      const profiles = candidates.map((candidate) =>
        toDynamicProfileEntry({ gateway, candidate }),
      );
      entries.push(...profiles);

      const bySource = new Map<string, Set<ModelGatewayProfileKind>>();
      for (const candidate of candidates) {
        const kinds = bySource.get(candidate.providerCatalogSource) ?? new Set<ModelGatewayProfileKind>();
        kinds.add(candidate.kind);
        bySource.set(candidate.providerCatalogSource, kinds);
      }
      for (const [source, kinds] of bySource.entries()) {
        successfulCatalogs.push({
          gatewaySlug: gateway.slug,
          source,
          kinds,
          aliases: new Set(
            profiles
              .filter((profile) => profile.providerCatalogSource === source)
              .map((profile) => profile.profileAlias),
          ),
        });
      }
    } catch (error) {
      logger.warn("Failed to discover gateway model catalog", {
        providerName: gateway.providerName,
        providerKind: gateway.providerKind,
        gatewaySlug: gateway.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    entries,
    successfulCatalogs,
    disabledCatalogs,
  };
}

async function syncProfileKind(input: {
  configVersionId: string;
  entries: Array<GlobalModelProfileEntry & {
    architecture?: Record<string, unknown>;
    contextLength?: number | null;
    defaultParameters?: Record<string, unknown> | null;
    displayName?: string;
    maxCompletionTokens?: number | null;
    providerCatalogSource?: string;
    providerCatalogGatewaySlug?: string;
    supportsImageInput?: boolean;
    supportedEfforts?: Array<"minimal" | "low" | "medium" | "high" | "xhigh">;
    supportedParameters?: string[];
    providerRouting?: GlobalModelProfileEntry["providerRouting"];
    litellmKey?: string;
  }>;
  gatewayIdBySlug: Map<string, string>;
  kind: ModelGatewayProfileKind;
  now: Date;
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0];
}) {
  for (const entry of input.entries) {
    const gatewayConfigId = input.gatewayIdBySlug.get(entry.gatewaySlug);
    if (!gatewayConfigId) {
      throw new Error(
        `Global model gateway config references missing gateway slug '${entry.gatewaySlug}' for ${input.kind} profile '${entry.modelAlias}'`,
      );
    }
    await upsertModelGatewayProfileFromGlobalConfig(
      input.kind,
      entry,
      gatewayConfigId,
      input.now,
      input.tx,
    );
    await input.tx.insert(modelGatewayRoutes).values({
      id: randomUUID(),
      configVersionId: input.configVersionId,
      alias: entry.profileAlias,
      routeKind: input.kind,
      strategy: entry.routingStrategy,
      targetProviderName: entry.providerName,
      targetModel: entry.targetModel,
      priority: entry.priority,
      weight: entry.weight,
      constraintsJson: buildRouteConstraintsJson(entry),
      isDefault: entry.isDefault,
      isActive: entry.isActive,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }
}

export function buildRouteConstraintsJson(input: {
  providerRouting?: GlobalModelProfileEntry["providerRouting"];
}): Record<string, unknown> {
  return input.providerRouting
    ? { providerRouting: input.providerRouting }
    : {};
}

async function syncGlobalModelGatewayConfigFromFile(
  configPath: string,
  options?: { syncPricing?: boolean },
) {
  const loaded = await loadGlobalModelGatewayConfig(configPath);
  if (!loaded) {
    return;
  }

  const dynamicCatalog = await loadDynamicCatalogProfiles({
    gateways: loaded.gateways.filter((gateway) => gateway.isActive),
    litellmData: null,
  });
  const dynamicByKind = groupDynamicProfilesByKind({
    entries: dynamicCatalog.entries,
  });
  const configuredChatProfileAliases = buildProfileAliasSet(loaded.chatProfiles);
  const configuredImageProfileAliases = buildProfileAliasSet(loaded.imageProfiles);
  const configuredVisionProfileAliases = buildProfileAliasSet(loaded.visionProfiles);
  const configuredTtsProfileAliases = buildProfileAliasSet(loaded.ttsProfiles);

  const chatProfilesToSync = [
    ...loaded.chatProfiles,
    ...(dynamicByKind.get("chat") ?? []).filter((entry) =>
      !hasProfileAlias(configuredChatProfileAliases, entry.profileAlias)
    ),
  ];
  const imageProfilesToSync = [
    ...loaded.imageProfiles,
    ...(dynamicByKind.get("image") ?? []).filter((entry) =>
      !hasProfileAlias(configuredImageProfileAliases, entry.profileAlias)
    ),
  ];
  const visionProfilesToSync = [
    ...loaded.visionProfiles,
    ...(dynamicByKind.get("vision") ?? []).filter((entry) =>
      !hasProfileAlias(configuredVisionProfileAliases, entry.profileAlias)
    ),
  ];
  const embeddingProfilesToSync = [
    ...loaded.embeddingProfiles,
    ...(dynamicByKind.get("embedding") ?? []),
  ];
  const rerankProfilesToSync = [
    ...loaded.rerankProfiles,
    ...(dynamicByKind.get("rerank") ?? []),
  ];
  const asrProfilesToSync = [
    ...loaded.asrProfiles,
    ...(dynamicByKind.get("asr") ?? []),
  ];
  const ttsProfilesToSync = [
    ...loaded.ttsProfiles,
    ...(dynamicByKind.get("tts") ?? []).filter((entry) =>
      !hasProfileAlias(configuredTtsProfileAliases, entry.profileAlias)
    ),
  ];
  const videoProfilesToSync = dynamicByKind.get("video") ?? [];

  assertUniqueProfiles("chat", chatProfilesToSync);
  assertUniqueProfiles("image", imageProfilesToSync);
  assertUniqueProfiles("vision", visionProfilesToSync);
  assertUniqueProfiles("rerank", rerankProfilesToSync);
  assertUniqueProfiles("asr", asrProfilesToSync);
  assertUniqueProfiles("embedding", embeddingProfilesToSync);
  assertUniqueProfiles("tts", ttsProfilesToSync);
  assertUniqueProfiles("video", videoProfilesToSync);
  assertUniqueRoutes("chat", chatProfilesToSync);
  assertUniqueRoutes("image", imageProfilesToSync);
  assertUniqueRoutes("vision", visionProfilesToSync);
  assertUniqueRoutes("rerank", rerankProfilesToSync);
  assertUniqueRoutes("asr", asrProfilesToSync);
  assertUniqueRoutes("embedding", embeddingProfilesToSync);
  assertUniqueRoutes("tts", ttsProfilesToSync);
  assertUniqueRoutes("video", videoProfilesToSync);

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
        apiKeyHeaderName: entry.apiKeyHeaderName ?? null,
        apiKeyHeaderPrefix: entry.apiKeyHeaderPrefix ?? null,
        defaultHeaders: entry.defaultHeaders,
        ...(entry.modelCatalog ? { modelCatalog: entry.modelCatalog } : {}),
      } satisfies Record<string, unknown>;

      let gatewayConfigId = existing?.id;
      if (existing) {
        await tx
          .update(modelGatewayConfigs)
          .set({
            slug: entry.slug,
            baseUrl: entry.baseUrl,
            apiKeyEncrypted,
            timeoutMs: resolveModelGatewayTimeoutMs(entry.timeoutMs),
            maxRetries: resolveModelGatewayMaxRetries(entry.maxRetries),
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
          timeoutMs: resolveModelGatewayTimeoutMs(entry.timeoutMs),
          maxRetries: resolveModelGatewayMaxRetries(entry.maxRetries),
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
      const providerConfigs = [
        {
          providerName: entry.providerName,
          providerKind: entry.providerKind,
          supports: entry.supports,
        },
      ];

      for (const providerConfig of providerConfigs) {
        await tx.insert(modelGatewayProviderConfigs).values({
          id: randomUUID(),
          configVersionId,
          providerName: providerConfig.providerName,
          providerKind: providerConfig.providerKind,
          gatewayConfigId,
          baseUrl: entry.baseUrl,
          apiKeySource: entry.apiKeyEnv ?? null,
          isActive: entry.isActive,
          capabilitiesJson: providerConfig.supports,
          configJson: {
            timeoutMs: resolveModelGatewayTimeoutMs(entry.timeoutMs),
            maxRetries: resolveModelGatewayMaxRetries(entry.maxRetries),
            isBYOK: entry.isBYOK,
            defaultHeaders: withOpenRouterAttributionHeaders({
              providerKind: providerConfig.providerKind,
              defaultHeaders: entry.defaultHeaders,
            }),
            apiKeyHeaderName: entry.apiKeyHeaderName ?? null,
            apiKeyHeaderPrefix: entry.apiKeyHeaderPrefix ?? null,
          },
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    await syncProfileKind({
      configVersionId,
      entries: chatProfilesToSync,
      gatewayIdBySlug,
      kind: "chat",
      now,
      tx,
    });
    await syncProfileKind({
      configVersionId,
      entries: imageProfilesToSync,
      gatewayIdBySlug,
      kind: "image",
      now,
      tx,
    });
    await syncProfileKind({
      configVersionId,
      entries: visionProfilesToSync,
      gatewayIdBySlug,
      kind: "vision",
      now,
      tx,
    });
    await syncProfileKind({
      configVersionId,
      entries: rerankProfilesToSync,
      gatewayIdBySlug,
      kind: "rerank",
      now,
      tx,
    });
    await syncProfileKind({
      configVersionId,
      entries: asrProfilesToSync,
      gatewayIdBySlug,
      kind: "asr",
      now,
      tx,
    });
    await syncProfileKind({
      configVersionId,
      entries: embeddingProfilesToSync,
      gatewayIdBySlug,
      kind: "embedding",
      now,
      tx,
    });
    await syncProfileKind({
      configVersionId,
      entries: ttsProfilesToSync,
      gatewayIdBySlug,
      kind: "tts",
      now,
      tx,
    });
    await syncProfileKind({
      configVersionId,
      entries: videoProfilesToSync,
      gatewayIdBySlug,
      kind: "video",
      now,
      tx,
    });

    await deactivateMissingStaticProfiles({
      aliases: new Set(loaded.chatProfiles.map((entry) => entry.profileAlias)),
      kind: "chat",
      now,
      tx,
    });
    await deactivateMissingStaticProfiles({
      aliases: new Set(loaded.imageProfiles.map((entry) => entry.profileAlias)),
      kind: "image",
      now,
      tx,
    });
    await deactivateMissingStaticProfiles({
      aliases: new Set(loaded.visionProfiles.map((entry) => entry.profileAlias)),
      kind: "vision",
      now,
      tx,
    });
    await deactivateMissingStaticProfiles({
      aliases: new Set(loaded.rerankProfiles.map((entry) => entry.profileAlias)),
      kind: "rerank",
      now,
      tx,
    });
    await deactivateMissingStaticProfiles({
      aliases: new Set(loaded.asrProfiles.map((entry) => entry.profileAlias)),
      kind: "asr",
      now,
      tx,
    });
    await deactivateMissingStaticProfiles({
      aliases: new Set(
        loaded.embeddingProfiles.map((entry) => entry.profileAlias),
      ),
      kind: "embedding",
      now,
      tx,
    });
    await deactivateMissingStaticProfiles({
      aliases: new Set(loaded.ttsProfiles.map((entry) => entry.profileAlias)),
      kind: "tts",
      now,
      tx,
    });
    await deactivateMissingStaticProfiles({
      aliases: new Set<string>(),
      kind: "video",
      now,
      tx,
    });

    for (const catalog of dynamicCatalog.successfulCatalogs) {
      const gatewayConfigId = gatewayIdBySlug.get(catalog.gatewaySlug);
      if (!gatewayConfigId) {
        continue;
      }
      for (const kind of catalog.kinds) {
        await deactivateMissingCatalogProfiles({
          aliases: catalog.aliases,
          gatewayConfigId,
          gatewaySlug: catalog.gatewaySlug,
          kind,
          now,
          source: catalog.source,
          tx,
        });
      }
    }

    for (const catalog of dynamicCatalog.disabledCatalogs) {
      const gatewayConfigId = gatewayIdBySlug.get(catalog.gatewaySlug);
      if (!gatewayConfigId) {
        continue;
      }
      await deactivateCatalogProfilesForGateway({
        gatewayConfigId,
        gatewaySlug: catalog.gatewaySlug,
        kinds: catalog.kinds,
        now,
        sources: catalog.sources,
        tx,
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
    rerankProfiles: rerankProfilesToSync.length,
    asrProfiles: asrProfilesToSync.length,
    embeddingProfiles: embeddingProfilesToSync.length,
    ttsProfiles: ttsProfilesToSync.length,
    videoProfiles: videoProfilesToSync.length,
    dynamicProfiles: dynamicCatalog.entries.length,
  });

  if (options?.syncPricing !== false) {
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
}

export async function syncGlobalModelGatewayConfig(options?: {
  syncPricing?: boolean;
}) {
  if (modelConfigSyncPromise) {
    return modelConfigSyncPromise;
  }

  modelConfigSyncPromise = (async () => {
    const globalConfigPath = resolveGlobalModelGatewayConfigPath();
    await syncGlobalModelGatewayConfigFromFile(globalConfigPath, options);
  })().catch((error) => {
    modelConfigSyncPromise = null;
    throw error;
  });

  return modelConfigSyncPromise;
}
