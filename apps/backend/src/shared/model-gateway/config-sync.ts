import { randomUUID } from "node:crypto";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, ne, sql } from "drizzle-orm";
import { config } from "../config";
import { db } from "../database";
import {
  modelGatewayConfigVersions,
  modelGatewayConfigs,
  modelGatewayProviderConfigs,
  modelGatewayRoutes,
  modelGatewayProfiles,
} from "../db/schema";
import { logger } from "../logger";
import {
  type GlobalGatewayEntry,
  type GlobalProfilePricingEntry,
  loadGlobalModelGatewayConfig,
} from "./global-config";
import {
  type DynamicOpenRouterProfileEntry,
  fetchDynamicOpenRouterProfiles,
} from "./openrouter-catalog";
import { buildProfilePricingConfigJson } from "./profiles";
import {
  resolveModelGatewayMaxRetries,
  resolveModelGatewayTimeoutMs,
  withOpenRouterAttributionHeaders,
} from "./runtime";
import type { ModelGatewayProfileKind } from "./types";
import { encryptSecret } from "../secrets";
import { syncModelPricing } from "../scripts/sync-model-pricing";

const GLOBAL_MODEL_GATEWAY_CONFIG_RELATIVE_PATH = "../../../config/model-gateway.global.json";

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

function buildOpenRouterProfileIndex(entries: DynamicOpenRouterProfileEntry[]) {
  return new Map(entries.map((entry) => [entry.targetModel, entry]));
}

function applyOpenRouterFacts<T extends {
  architecture?: Record<string, unknown>;
  contextLength?: number | null;
  defaultParameters?: Record<string, unknown> | null;
  displayName?: string;
  gatewaySlug: string;
  maxCompletionTokens?: number | null;
  pricing?: GlobalProfilePricingEntry | null;
  providerCatalogSource?: string;
  supportedEfforts?: Array<"minimal" | "low" | "medium" | "high" | "xhigh">;
  supportedParameters?: string[];
  targetModel: string;
  profileAlias: string;
}>(
  entry: T,
  input: {
    openrouterGatewaySlug?: string;
    openrouterProfilesByTarget: Map<string, DynamicOpenRouterProfileEntry>;
  },
): T {
  if (!input.openrouterGatewaySlug || entry.gatewaySlug !== input.openrouterGatewaySlug) {
    return entry;
  }

  const facts = input.openrouterProfilesByTarget.get(entry.targetModel);
  if (!facts) {
    return entry;
  }

  return {
    ...entry,
    architecture: entry.architecture ?? facts.architecture,
    contextLength: entry.contextLength ?? facts.contextLength,
    defaultParameters: entry.defaultParameters ?? facts.defaultParameters,
    displayName: entry.displayName ?? facts.displayName,
    maxCompletionTokens: entry.maxCompletionTokens ?? facts.maxCompletionTokens,
    pricing: entry.pricing ?? facts.pricing,
    providerCatalogSource: entry.providerCatalogSource ?? "openrouter-models",
    supportedEfforts: entry.supportedEfforts && entry.supportedEfforts.length > 0
      ? entry.supportedEfforts
      : facts.supportedEfforts,
    supportedParameters: entry.supportedParameters && entry.supportedParameters.length > 0
      ? entry.supportedParameters
      : facts.supportedParameters,
  };
}

export function resolveGlobalModelGatewayConfigPath() {
  const configuredPath = config.modelGatewayGlobalConfigPath?.trim();
  if (configuredPath) {
    return configuredPath;
  }

  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDirPath = dirname(currentFilePath);
  return resolvePath(currentDirPath, GLOBAL_MODEL_GATEWAY_CONFIG_RELATIVE_PATH);
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
    architecture?: Record<string, unknown>;
    contextLength?: number | null;
    defaultParameters?: Record<string, unknown> | null;
    displayName?: string;
    maxCompletionTokens?: number | null;
    subtitle?: string;
    badges?: string[];
    supportedParameters?: string[];
    supportedEfforts?: Array<"minimal" | "low" | "medium" | "high" | "xhigh">;
    imageGeneration?: Record<string, unknown>;
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
      targetModel: entry.targetModel,
      ...(entry.displayName ? { displayName: entry.displayName } : {}),
      ...(entry.subtitle ? { subtitle: entry.subtitle } : {}),
      ...(entry.badges && entry.badges.length > 0 ? { badges: entry.badges } : {}),
      ...(entry.providerCatalogSource
        ? { providerCatalogSource: entry.providerCatalogSource }
        : {}),
      ...(entry.architecture ? { architecture: entry.architecture } : {}),
      ...(entry.contextLength ? { contextLength: entry.contextLength } : {}),
      ...(entry.defaultParameters ? { defaultParameters: entry.defaultParameters } : {}),
      ...(entry.maxCompletionTokens
        ? { maxCompletionTokens: entry.maxCompletionTokens }
        : {}),
      ...(entry.supportedParameters && entry.supportedParameters.length > 0
        ? { supportedParameters: entry.supportedParameters }
        : {}),
      ...(entry.supportedEfforts && entry.supportedEfforts.length > 0
        ? { supportedEfforts: entry.supportedEfforts }
        : {}),
      ...(entry.imageGeneration ? { imageGeneration: entry.imageGeneration } : {}),
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
  const dynamicOpenRouterProfiles = openrouterGateway && config.modelGatewaySyncOpenRouterCatalog
    ? await fetchDynamicOpenRouterProfiles()
    : {
        chat: [],
        image: [],
        vision: [],
      };
  const openrouterProfilesByKind = {
    chat: buildOpenRouterProfileIndex(dynamicOpenRouterProfiles.chat),
    image: buildOpenRouterProfileIndex(dynamicOpenRouterProfiles.image),
    vision: buildOpenRouterProfileIndex(dynamicOpenRouterProfiles.vision),
  };
  const openrouterGatewaySlug = openrouterGateway?.slug;
  const openrouterProviderName = openrouterGateway?.providerName ?? "openrouter";
  const configuredChatProfileAliases = buildProfileAliasSet(loaded.chatProfiles);
  const configuredImageProfileAliases = buildProfileAliasSet(loaded.imageProfiles);
  const configuredVisionProfileAliases = buildProfileAliasSet(loaded.visionProfiles);

  const chatProfilesToSync = [
    ...loaded.chatProfiles.map((entry) =>
      applyOpenRouterFacts(entry, {
        openrouterGatewaySlug,
        openrouterProfilesByTarget: openrouterProfilesByKind.chat,
      })
    ),
    ...dynamicOpenRouterProfiles.chat.filter((entry) =>
      !hasProfileAlias(configuredChatProfileAliases, entry.profileAlias)
    ).map((entry) => ({
      profileAlias: entry.profileAlias,
      modelAlias: entry.targetModel,
      gatewaySlug: openrouterGateway?.slug ?? "",
      providerName: openrouterProviderName,
      targetModel: entry.targetModel,
      routingStrategy: "priority" as const,
      priority: 100,
      weight: 100,
      isDefault: false,
      isActive: true,
      pricing: entry.pricing,
      supportedParameters: entry.supportedParameters,
      supportedEfforts: entry.supportedEfforts,
      providerCatalogSource: "openrouter-models",
      architecture: entry.architecture,
      contextLength: entry.contextLength,
      defaultParameters: entry.defaultParameters,
      displayName: entry.displayName,
      maxCompletionTokens: entry.maxCompletionTokens,
      subtitle: entry.targetModel,
    })),
  ];
  const imageProfilesToSync = [
    ...loaded.imageProfiles.map((entry) =>
      applyOpenRouterFacts(entry, {
        openrouterGatewaySlug,
        openrouterProfilesByTarget: openrouterProfilesByKind.image,
      })
    ),
    ...dynamicOpenRouterProfiles.image.filter((entry) =>
      !hasProfileAlias(configuredImageProfileAliases, entry.profileAlias)
    ).map((entry) => ({
      profileAlias: entry.profileAlias,
      modelAlias: entry.targetModel,
      gatewaySlug: openrouterGateway?.slug ?? "",
      providerName: openrouterProviderName,
      targetModel: entry.targetModel,
      routingStrategy: "priority" as const,
      priority: 100,
      weight: 100,
      isDefault: false,
      isActive: true,
      pricing: entry.pricing,
      supportedParameters: entry.supportedParameters,
      supportedEfforts: entry.supportedEfforts,
      providerCatalogSource: "openrouter-models",
      architecture: entry.architecture,
      contextLength: entry.contextLength,
      defaultParameters: entry.defaultParameters,
      displayName: entry.displayName,
      maxCompletionTokens: entry.maxCompletionTokens,
      subtitle: entry.targetModel,
    })),
  ];
  const visionProfilesToSync = [
    ...loaded.visionProfiles.map((entry) =>
      applyOpenRouterFacts(entry, {
        openrouterGatewaySlug,
        openrouterProfilesByTarget: openrouterProfilesByKind.vision,
      })
    ),
    ...dynamicOpenRouterProfiles.vision.filter((entry) =>
      !hasProfileAlias(configuredVisionProfileAliases, entry.profileAlias)
    ).map((entry) => ({
      profileAlias: entry.profileAlias,
      modelAlias: entry.targetModel,
      gatewaySlug: openrouterGateway?.slug ?? "",
      providerName: openrouterProviderName,
      targetModel: entry.targetModel,
      routingStrategy: "priority" as const,
      priority: 100,
      weight: 100,
      isDefault: false,
      isActive: true,
      pricing: entry.pricing,
      supportedParameters: entry.supportedParameters,
      supportedEfforts: entry.supportedEfforts,
      providerCatalogSource: "openrouter-models",
      architecture: entry.architecture,
      contextLength: entry.contextLength,
      defaultParameters: entry.defaultParameters,
      displayName: entry.displayName,
      maxCompletionTokens: entry.maxCompletionTokens,
      subtitle: entry.targetModel,
    })),
  ];

  assertUniqueProfiles("chat", chatProfilesToSync);
  assertUniqueProfiles("image", imageProfilesToSync);
  assertUniqueProfiles("vision", visionProfilesToSync);
  assertUniqueProfiles("asr", loaded.asrProfiles);
  assertUniqueRoutes("chat", chatProfilesToSync);
  assertUniqueRoutes("image", imageProfilesToSync);
  assertUniqueRoutes("vision", visionProfilesToSync);
  assertUniqueRoutes("asr", loaded.asrProfiles);

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
        defaultHeaders: entry.defaultHeaders,
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
          },
          createdAt: now,
          updatedAt: now,
        });
      }
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
        alias: entry.profileAlias,
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
        alias: entry.profileAlias,
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
        alias: entry.profileAlias,
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
        alias: entry.profileAlias,
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
      .where(eq(modelGatewayProfiles.kind, "asr"));

    for (const entry of loaded.asrProfiles) {
      const gatewayConfigId = gatewayIdBySlug.get(entry.gatewaySlug);
      if (!gatewayConfigId) {
        throw new Error(
          `Global model gateway config references missing gateway slug '${entry.gatewaySlug}' for asr profile '${entry.modelAlias}'`,
        );
      }
      await upsertModelGatewayProfileFromGlobalConfig(
        "asr",
        entry,
        gatewayConfigId,
        now,
        tx,
      );
      await tx.insert(modelGatewayRoutes).values({
        id: randomUUID(),
        configVersionId,
        alias: entry.profileAlias,
        routeKind: "asr",
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
        alias: entry.profileAlias,
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
    asrProfiles: loaded.asrProfiles.length,
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
