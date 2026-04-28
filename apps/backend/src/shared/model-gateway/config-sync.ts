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
  type GlobalProfilePricingEntry,
  loadGlobalModelGatewayConfig,
} from "./global-config";
import { fetchDynamicOpenRouterProfiles } from "./openrouter-catalog";
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
  const dynamicOpenRouterProfiles = openrouterGateway && config.modelGatewaySyncOpenRouterCatalog
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
          timeoutMs: resolveModelGatewayTimeoutMs(entry.timeoutMs),
          maxRetries: resolveModelGatewayMaxRetries(entry.maxRetries),
          isBYOK: entry.isBYOK,
          defaultHeaders: withOpenRouterAttributionHeaders({
            providerKind: entry.providerKind,
            defaultHeaders: entry.defaultHeaders,
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
