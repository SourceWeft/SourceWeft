import { eq, and } from "drizzle-orm";
import {
  db,
  modelGatewayConfigVersions,
  modelGatewayProfiles,
  type ModelPricing,
  modelGatewayRoutes,
} from "@sourceweft/db";
import { logger } from "../logger";
import { config } from "../config";
import {
  autoMatchModelAlias,
  fetchLiteLLMPricing,
  resolveLiteLLMCapabilities,
  type LiteLLMEntry,
  type LiteLLMData,
  type ModelAliasMatch,
} from "./litellm-capabilities";
import { mergeOwnedProfileConfig } from "./profile-config-priority";

function toRouteKey(kind: string, alias: string) {
  return `${kind}:${alias}`;
}

async function loadActiveRouteTargetsByKindAndAlias(): Promise<Map<string, string[]>> {
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
    })
    .from(modelGatewayRoutes)
    .where(
      and(
        eq(modelGatewayRoutes.configVersionId, activeVersion.id),
        eq(modelGatewayRoutes.isActive, true),
      ),
    );

  const targetsByRoute = new Map<string, Set<string>>();
  for (const row of routeRows) {
    const routeKind = row.routeKind.trim();
    const alias = row.alias.trim();
    const targetModel = row.targetModel.trim();
    if (!routeKind || !alias || !targetModel) {
      continue;
    }
    const routeKey = toRouteKey(routeKind, alias);
    const existing = targetsByRoute.get(routeKey) ?? new Set<string>();
    existing.add(targetModel);
    targetsByRoute.set(routeKey, existing);
  }

  return new Map(
    Array.from(targetsByRoute.entries()).map(([routeKey, targets]) => [
      routeKey,
      Array.from(targets),
    ]),
  );
}

function resolveMatchFromCandidates(
  candidates: string[],
  litellmKeys: string[],
): ModelAliasMatch {
  const matches: string[] = [];
  for (const candidate of candidates) {
    const result = autoMatchModelAlias(candidate, litellmKeys);
    if (result.type === "matched") {
      matches.push(result.key);
      continue;
    }
    if (result.type === "ambiguous") {
      return result;
    }
  }

  const uniqueMatches = Array.from(new Set(matches));
  if (uniqueMatches.length === 1) {
    const key = uniqueMatches[0];
    if (key) {
      return { type: "matched", key };
    }
  }

  if (uniqueMatches.length > 1) {
    return { type: "ambiguous", candidates: uniqueMatches };
  }

  return { type: "unmatched" };
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

function isLiteLLMManagedPriceSource(source: unknown): boolean {
  if (source === undefined || source === null) {
    return true;
  }
  if (typeof source !== "string") {
    return true;
  }
  const normalized = source.trim().toLowerCase();
  return normalized === "" || normalized === "unknown" || normalized === "litellm";
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
    !isLiteLLMManagedPriceSource(pricing.price_source) &&
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

function buildLiteLLMSyncUpdates(input: {
  litellmEntry: LiteLLMEntry;
  litellmKey: string;
  now: Date;
  pricingLocked: boolean;
}) {
  const capabilityUpdates = resolveLiteLLMCapabilities(input.litellmEntry);
  if (input.pricingLocked) {
    return capabilityUpdates as unknown as Record<string, unknown>;
  }

  const pricingUpdates: ModelPricing = {
    input_cost_per_token: normalizePriceNumber(
      input.litellmEntry.input_cost_per_token,
    ),
    output_cost_per_token: normalizePriceNumber(
      input.litellmEntry.output_cost_per_token,
    ),
    cache_read_input_token_cost: normalizePriceNumber(
      input.litellmEntry.cache_read_input_token_cost,
    ),
    cache_creation_input_token_cost: normalizePriceNumber(
      input.litellmEntry.cache_creation_input_token_cost,
    ),
    output_cost_per_reasoning_token: normalizePriceNumber(
      input.litellmEntry.output_cost_per_reasoning_token,
    ),
    input_cost_per_image_token: normalizePriceNumber(
      input.litellmEntry.input_cost_per_image_token,
    ),
    output_cost_per_image_token: normalizePriceNumber(
      input.litellmEntry.output_cost_per_image_token,
    ),
    input_cost_per_audio_token: normalizePriceNumber(
      input.litellmEntry.input_cost_per_audio_token,
    ),
    output_cost_per_audio_token: normalizePriceNumber(
      input.litellmEntry.output_cost_per_audio_token,
    ),
    input_cost_per_image: normalizePriceNumber(
      input.litellmEntry.input_cost_per_image,
    ),
    output_cost_per_image: normalizePriceNumber(
      input.litellmEntry.output_cost_per_image,
    ),
    price_source: "litellm",
    litellm_key: input.litellmKey,
    price_updated_at: input.now.toISOString(),
  };

  return {
    ...(pricingUpdates as unknown as Record<string, unknown>),
    ...(capabilityUpdates as unknown as Record<string, unknown>),
  };
}

export async function syncModelPricing(): Promise<void> {
  const litellmData = await fetchLiteLLMPricing(config.litellmPricingUrl);
  const litellmKeys = Object.keys(litellmData);
  const activeRouteTargetsByKindAndAlias =
    await loadActiveRouteTargetsByKindAndAlias();

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
  let presetKeyUsed = 0;
  let autoMatched = 0;
  let invalidPresetKey = 0;

  for (const profile of profiles) {
    const routeTargets =
      activeRouteTargetsByKindAndAlias.get(
        toRouteKey(profile.kind, profile.profileAlias),
      ) ?? [];
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

    let match: ModelAliasMatch;
    if (existingPricing?.litellm_key) {
      presetKeyUsed++;
      if (litellmKeys.includes(existingPricing.litellm_key)) {
        match = { type: "matched", key: existingPricing.litellm_key };
      } else {
        invalidPresetKey++;
        match = { type: "unmatched" };
        logger.warn(
          pricingLocked
            ? "Preset LiteLLM key is invalid, preserved externally managed pricing"
            : "Preset LiteLLM key is invalid, marked as unknown",
          {
            kind: profile.kind,
            profileAlias: profile.profileAlias,
            modelAlias: profile.modelAlias,
            litellmKey: existingPricing.litellm_key,
          },
        );
      }
    } else {
      match = resolveMatchFromCandidates(
        [profile.modelAlias, ...routeTargets],
        litellmKeys,
      );
      if (match.type === "matched") {
        autoMatched++;
      }
    }

    if (match.type === "matched") {
      const litellmEntry = litellmData[match.key];
      if (!litellmEntry) {
        unmatched++;
        logger.warn("LiteLLM price key matched but entry missing", {
          kind: profile.kind,
          profileAlias: profile.profileAlias,
          modelAlias: profile.modelAlias,
          litellmKey: match.key,
        });
        continue;
      }
      matched++;

      const now = new Date();
      const nextConfigJson = mergeModelPricingSyncConfig({
        existingConfigJson,
        pricingLocked,
        updates: buildLiteLLMSyncUpdates({
          litellmEntry,
          litellmKey: match.key,
          now,
          pricingLocked,
        }),
      });

      if (!configJsonEqual(existingConfigJson, nextConfigJson)) {
        await db
          .update(modelGatewayProfiles)
          .set({
            configJson: nextConfigJson,
            updatedAt: now,
          })
          .where(eq(modelGatewayProfiles.id, profile.id));
        updated++;
        logger.info("Updated model pricing", {
          kind: profile.kind,
          profileAlias: profile.profileAlias,
          modelAlias: profile.modelAlias,
          litellmKey: match.key,
          inputCost: nextConfigJson.input_cost_per_token,
          outputCost: nextConfigJson.output_cost_per_token,
        });
      }
    } else {
      unmatched++;
      if (match.type === "ambiguous") {
        logger.warn(
          pricingLocked
            ? "LiteLLM price match is ambiguous, preserved externally managed pricing"
            : "LiteLLM price match is ambiguous, marked as unknown",
          {
            kind: profile.kind,
            profileAlias: profile.profileAlias,
            modelAlias: profile.modelAlias,
            routeTargets,
            candidates: match.candidates,
          },
        );
      }
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
          .set({
            configJson: nextConfigJson,
            updatedAt: now,
          })
          .where(eq(modelGatewayProfiles.id, profile.id));
        logger.warn("No LiteLLM price match found, marked as unknown", {
          kind: profile.kind,
          profileAlias: profile.profileAlias,
          modelAlias: profile.modelAlias,
          routeTargets,
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
    presetKeyUsed,
    autoMatched,
    invalidPresetKey,
  });
}

export async function resolveModelCapabilitiesFromLitellm(modelName: string) {
  const litellmData = await fetchLiteLLMPricing(config.litellmPricingUrl);
  const litellmKeys = Object.keys(litellmData);
  const match = autoMatchModelAlias(modelName, litellmKeys);
  if (match.type !== "matched") {
    return null;
  }

  const entry = litellmData[match.key];
  if (!entry) {
    return null;
  }

  return {
    litellmKey: match.key,
    ...resolveLiteLLMCapabilities(entry),
  };
}

export const testExports = {
  buildLiteLLMSyncUpdates,
  hasAnyFinitePriceValue,
  isExternallyManagedPricing,
  isLiteLLMManagedPriceSource,
  shouldSkipLiteLLMAutoMatch,
};
