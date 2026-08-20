import { eq, and } from "drizzle-orm";
import {
  db,
  modelGatewayConfigVersions,
  modelGatewayProfiles,
  type ModelPricing,
  modelGatewayRoutes,
} from "@sourceweft/db";
import { logger } from "../logger";
import { modelCatalog } from "./model-catalog/registry";
import type { NormalizedModelInfo } from "./model-catalog/types";
import { mergeOwnedProfileConfig } from "./profile-config-priority";

function toRouteKey(kind: string, alias: string) {
  return `${kind}:${alias}`;
}

/**
 * Only the primary target (lowest priority number) is returned per alias.
 *
 * An alias is priced once, at the alias, because that is what the user is
 * charged regardless of which target serves the request. Feeding every target
 * into the LiteLLM auto-match would make a multi-target alias resolve
 * `ambiguous`, which downgrades it to `price_source: "unknown"` and quietly
 * bills every call at the one-credit floor. Deriving from a single, stable
 * target keeps the alias priced or explicitly unmatched — never accidentally
 * free.
 */
async function loadPrimaryRouteTargetByKindAndAlias(): Promise<Map<string, string>> {
  const [activeVersion] = await db
    .select({ id: modelGatewayConfigVersions.id })
    .from(modelGatewayConfigVersions)
    .where(eq(modelGatewayConfigVersions.isActive, true))
    .limit(1);

  if (!activeVersion) {
    return new Map();
  }

  const routeRows = await db
    .select({
      routeKind: modelGatewayRoutes.routeKind,
      alias: modelGatewayRoutes.alias,
      targetModel: modelGatewayRoutes.targetModel,
      priority: modelGatewayRoutes.priority,
    })
    .from(modelGatewayRoutes)
    .where(
      and(
        eq(modelGatewayRoutes.configVersionId, activeVersion.id),
        eq(modelGatewayRoutes.isActive, true),
      ),
    );

  const primaryByRoute = new Map<string, { targetModel: string; priority: number }>();
  for (const row of routeRows) {
    const routeKind = row.routeKind.trim();
    const alias = row.alias.trim();
    const targetModel = row.targetModel.trim();
    if (!routeKind || !alias || !targetModel) {
      continue;
    }
    const routeKey = toRouteKey(routeKind, alias);
    const current = primaryByRoute.get(routeKey);
    // Ties break on target model so the derived price never depends on row order.
    if (
      !current ||
      row.priority < current.priority ||
      (row.priority === current.priority && targetModel < current.targetModel)
    ) {
      primaryByRoute.set(routeKey, { targetModel, priority: row.priority });
    }
  }

  return new Map(
    Array.from(primaryByRoute.entries()).map(([routeKey, primary]) => [
      routeKey,
      primary.targetModel,
    ]),
  );
}

function normalizePriceNumber(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  return Number(value.toPrecision(15));
}

const PRICING_VALUE_KEYS = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_read_input_token_cost",
  "cache_creation_input_token_cost",
  "output_cost_per_reasoning_token",
  "input_cost_per_image_token",
  "output_cost_per_image_token",
  "input_cost_per_audio_token",
  "output_cost_per_audio_token",
  "input_cost_per_image",
  "output_cost_per_image",
] as const satisfies ReadonlyArray<keyof ModelPricing>;

type ModelPricingConfig = Partial<Omit<ModelPricing, "price_source">> & {
  price_source?: string | null;
};

// "Auto-managed" price sources are the ones this sync owns and may overwrite:
// the model catalog (registry / models.dev / litellm), plus empty/unknown.
// Anything else (e.g. "manual") is an operator override we must preserve.
function isAutoManagedPriceSource(source: unknown): boolean {
  if (source === undefined || source === null || typeof source !== "string") {
    return true;
  }
  const normalized = source.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "unknown" ||
    normalized === "litellm" ||
    normalized === "models.dev" ||
    normalized === "registry"
  );
}

function hasAnyFinitePriceValue(
  pricing:
    | Partial<Record<(typeof PRICING_VALUE_KEYS)[number], unknown>>
    | undefined,
): boolean {
  if (!pricing) {
    return false;
  }
  return PRICING_VALUE_KEYS.some((key) => {
    const value = pricing[key];
    return typeof value === "number" && Number.isFinite(value);
  });
}

function isExternallyManagedPricing(
  pricing: ModelPricingConfig | undefined,
): boolean {
  if (!pricing) {
    return false;
  }
  return (
    !isAutoManagedPriceSource(pricing.price_source) &&
    hasAnyFinitePriceValue(pricing)
  );
}

function shouldSkipLiteLLMAutoMatch(
  pricing: ModelPricingConfig | undefined,
): boolean {
  return isExternallyManagedPricing(pricing) && !pricing?.litellm_key;
}

const PRICING_SYNC_CONFIG_KEYS = new Set<string>([
  ...PRICING_VALUE_KEYS,
  "price_source",
  "litellm_key",
  "price_updated_at",
]);

const PROVIDER_METADATA_SYNC_CONFIG_KEYS = new Set<string>([
  "litellm_provider",
  "litellm_mode",
  "supportsImageInput",
  "supports_function_calling",
  "supports_parallel_function_calling",
  "supports_response_schema",
  "supports_tool_choice",
  "supports_prompt_caching",
  "max_input_tokens",
  "max_output_tokens",
  "max_completion_tokens",
  "supportedParameters",
  "supportedEfforts",
]);

const LITELLM_SYNC_CONFIG_KEYS = new Set<string>([
  ...PRICING_SYNC_CONFIG_KEYS,
  ...PROVIDER_METADATA_SYNC_CONFIG_KEYS,
]);

function toStableComparableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toStableComparableJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, toStableComparableJson(item)]),
  );
}

function configJsonEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  return (
    JSON.stringify(toStableComparableJson(left)) ===
    JSON.stringify(toStableComparableJson(right))
  );
}

export function mergeModelPricingSyncConfig(input: {
  existingConfigJson: Record<string, unknown>;
  pricingLocked?: boolean;
  updates: Record<string, unknown>;
}) {
  return mergeOwnedProfileConfig({
    configJson: input.existingConfigJson,
    ownedFields: input.pricingLocked
      ? PROVIDER_METADATA_SYNC_CONFIG_KEYS
      : LITELLM_SYNC_CONFIG_KEYS,
    updates: input.updates,
  });
}

// Neutral capabilities → the metadata config fields the sync owns.
function capabilityConfigFromInfo(
  info: NormalizedModelInfo,
): Record<string, unknown> {
  const supportedParameters: string[] = [];
  if (info.toolCall) {
    supportedParameters.push("tools", "tool_choice");
  }
  if (info.structuredOutput) {
    supportedParameters.push("response_format");
  }
  if (info.reasoning) {
    supportedParameters.push("reasoning_effort");
  }
  return {
    litellm_mode: info.modality ?? null,
    supportsImageInput: info.vision,
    supports_function_calling: info.toolCall,
    supports_response_schema: info.structuredOutput,
    max_input_tokens: info.contextTokens ?? null,
    max_output_tokens: info.maxOutputTokens ?? null,
    max_completion_tokens: info.maxOutputTokens ?? null,
    supportedParameters,
    ...(info.reasoningEfforts.length > 0
      ? { supportedEfforts: info.reasoningEfforts }
      : {}),
  };
}

// Neutral pricing → the price-book config fields (per-token USD).
function pricingConfigFromInfo(
  info: NormalizedModelInfo,
  now: Date,
): Record<string, unknown> {
  const p = info.pricing;
  const pricingUpdates: ModelPricing = {
    input_cost_per_token: normalizePriceNumber(p?.inputPerToken),
    output_cost_per_token: normalizePriceNumber(p?.outputPerToken),
    cache_read_input_token_cost: normalizePriceNumber(p?.cacheReadPerToken),
    cache_creation_input_token_cost: normalizePriceNumber(p?.cacheWritePerToken),
    output_cost_per_reasoning_token: normalizePriceNumber(
      p?.reasoningOutputPerToken,
    ),
    input_cost_per_image_token: null,
    output_cost_per_image_token: null,
    input_cost_per_audio_token: normalizePriceNumber(p?.audioInputPerToken),
    output_cost_per_audio_token: normalizePriceNumber(p?.audioOutputPerToken),
    input_cost_per_image: normalizePriceNumber(p?.inputPerImage),
    output_cost_per_image: normalizePriceNumber(p?.outputPerImage),
    price_source: "registry",
    litellm_key: null,
    price_updated_at: now.toISOString(),
  };
  return pricingUpdates as unknown as Record<string, unknown>;
}

// A profile's config update from the normalized catalog. When pricing is
// externally managed (operator override) only capabilities are refreshed.
function buildSyncUpdatesFromInfo(input: {
  info: NormalizedModelInfo;
  now: Date;
  pricingLocked: boolean;
}) {
  const capabilityUpdates = capabilityConfigFromInfo(input.info);
  if (input.pricingLocked) {
    return capabilityUpdates;
  }
  return {
    ...pricingConfigFromInfo(input.info, input.now),
    ...capabilityUpdates,
  };
}

export async function syncModelPricing(): Promise<void> {
  await modelCatalog.ensureReady();
  const primaryRouteTargetByKindAndAlias =
    await loadPrimaryRouteTargetByKindAndAlias();

  const profiles = await db
    .select({
      id: modelGatewayProfiles.id,
      kind: modelGatewayProfiles.kind,
      profileAlias: modelGatewayProfiles.profileAlias,
      modelAlias: modelGatewayProfiles.modelAlias,
      configJson: modelGatewayProfiles.configJson,
    })
    .from(modelGatewayProfiles)
    .where(eq(modelGatewayProfiles.isActive, true));

  let updated = 0;
  let matched = 0;
  let unmatched = 0;
  let preservedExternalPricing = 0;

  for (const profile of profiles) {
    const primaryRouteTarget = primaryRouteTargetByKindAndAlias.get(
      toRouteKey(profile.kind, profile.profileAlias),
    );
    const existingConfigJson =
      profile.configJson && typeof profile.configJson === "object"
        ? (profile.configJson as Record<string, unknown>)
        : {};
    const existingPricing = existingConfigJson as ModelPricingConfig;

    const pricingLocked = isExternallyManagedPricing(existingPricing);

    if (pricingLocked) {
      preservedExternalPricing++;
      if (shouldSkipLiteLLMAutoMatch(existingPricing)) {
        logger.info(
          "Preserved externally managed pricing; skipped LiteLLM auto match",
          {
            kind: profile.kind,
            profileAlias: profile.profileAlias,
            modelAlias: profile.modelAlias,
            priceSource: existingPricing.price_source,
          },
        );
        continue;
      }
      logger.info("Preserved externally managed pricing profile", {
        kind: profile.kind,
        profileAlias: profile.profileAlias,
        modelAlias: profile.modelAlias,
        priceSource: existingPricing.price_source,
        litellmKey: existingPricing.litellm_key,
      });
    }

    // Resolve capabilities + pricing from the normalized catalog by the alias's
    // primary target (or the alias itself). One source, models.dev-primary.
    const target = primaryRouteTarget ?? profile.modelAlias;
    const info = modelCatalog.resolve(target);

    if (info) {
      matched++;
      const now = new Date();
      const nextConfigJson = mergeModelPricingSyncConfig({
        existingConfigJson,
        pricingLocked,
        updates: buildSyncUpdatesFromInfo({ info, now, pricingLocked }),
      });

      if (!configJsonEqual(existingConfigJson, nextConfigJson)) {
        await db
          .update(modelGatewayProfiles)
          .set({ configJson: nextConfigJson, updatedAt: now })
          .where(eq(modelGatewayProfiles.id, profile.id));
        updated++;
        logger.info("Updated model pricing", {
          kind: profile.kind,
          profileAlias: profile.profileAlias,
          modelAlias: profile.modelAlias,
          target,
          inputCost: nextConfigJson.input_cost_per_token,
          outputCost: nextConfigJson.output_cost_per_token,
        });
      }
    } else {
      unmatched++;
      if (!pricingLocked && existingPricing?.price_source !== "unknown") {
        const now = new Date();
        const unknownPricing: ModelPricing = {
          input_cost_per_token: null,
          output_cost_per_token: null,
          cache_read_input_token_cost: null,
          cache_creation_input_token_cost: null,
          output_cost_per_reasoning_token: null,
          input_cost_per_image_token: null,
          output_cost_per_image_token: null,
          input_cost_per_audio_token: null,
          output_cost_per_audio_token: null,
          input_cost_per_image: null,
          output_cost_per_image: null,
          price_source: "unknown",
          litellm_key: null,
          price_updated_at: now.toISOString(),
        };
        const nextConfigJson = mergeModelPricingSyncConfig({
          existingConfigJson,
          updates: unknownPricing as unknown as Record<string, unknown>,
        });
        await db
          .update(modelGatewayProfiles)
          .set({ configJson: nextConfigJson, updatedAt: now })
          .where(eq(modelGatewayProfiles.id, profile.id));
        logger.warn("No catalog price match found, marked as unknown", {
          kind: profile.kind,
          profileAlias: profile.profileAlias,
          modelAlias: profile.modelAlias,
          target,
        });
      }
    }
  }

  logger.info("Model pricing sync completed", {
    total: profiles.length,
    matched,
    unmatched,
    updated,
    preservedExternalPricing,
  });
}

/**
 * Capability snapshot for a model id, resolved from the normalized catalog
 * (models.dev-primary). Kept litellm-shaped field names for existing consumers
 * (BYOK), but the data now comes from the single registry, not a direct fetch.
 */
export async function resolveModelCapabilitiesFromLitellm(modelName: string) {
  await modelCatalog.ensureReady();
  const info = modelCatalog.resolve(modelName);
  if (!info) {
    return null;
  }
  const supportedParameters: string[] = [];
  if (info.toolCall) {
    supportedParameters.push("tools", "tool_choice");
  }
  if (info.structuredOutput) {
    supportedParameters.push("response_format");
  }
  if (info.reasoning) {
    supportedParameters.push("reasoning_effort");
  }
  return {
    supportsImageInput: info.vision,
    supportedParameters,
    supportedEfforts: info.reasoningEfforts,
    max_completion_tokens: info.maxOutputTokens ?? null,
  };
}

export const testExports = {
  buildSyncUpdatesFromInfo,
  capabilityConfigFromInfo,
  pricingConfigFromInfo,
  hasAnyFinitePriceValue,
  isExternallyManagedPricing,
  isAutoManagedPriceSource,
  shouldSkipLiteLLMAutoMatch,
};
