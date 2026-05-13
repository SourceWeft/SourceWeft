import { eq, and, inArray } from "drizzle-orm";
import { closeDatabase, db } from "../database";
import {
  modelGatewayConfigVersions,
  modelGatewayProfiles,
  modelGatewayRoutes,
} from "../db/schema";
import type { ModelPricing } from "../db/schema-types";
import { logger } from "../logger";

const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

type LiteLLMEntry = {
  input_cost_per_token?: number | null;
  output_cost_per_token?: number | null;
  cache_read_input_token_cost?: number | null;
  cache_creation_input_token_cost?: number | null;
  output_cost_per_reasoning_token?: number | null;
  input_cost_per_image_token?: number | null;
  output_cost_per_image_token?: number | null;
  input_cost_per_audio_token?: number | null;
  output_cost_per_audio_token?: number | null;
  input_cost_per_image?: number | null;
  output_cost_per_image?: number | null;
  litellm_provider?: string;
  mode?: string;
};

type LiteLLMData = Record<string, LiteLLMEntry>;

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

async function fetchLiteLLMPricing(): Promise<LiteLLMData> {
  const response = await fetch(LITELLM_PRICING_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch LiteLLM pricing: ${response.statusText}`);
  }
  return response.json() as Promise<LiteLLMData>;
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

function normalizeModelPart(alias: string): string {
  const trimmed = alias.trim();
  if (!trimmed) {
    return "";
  }
  const parts = trimmed.split("/").filter((part) => part.length > 0);
  return (parts.at(-1) ?? trimmed).toLowerCase();
}

type ModelAliasMatch =
  | { type: "matched"; key: string }
  | { type: "unmatched" }
  | { type: "ambiguous"; candidates: string[] };

function autoMatchModelAlias(
  alias: string,
  litellmKeys: string[],
): ModelAliasMatch {
  if (litellmKeys.includes(alias)) {
    return { type: "matched", key: alias };
  }

  const modelPart = normalizeModelPart(alias);
  if (!modelPart) {
    return { type: "unmatched" };
  }

  for (const key of litellmKeys) {
    const keyModel = normalizeModelPart(key);
    if (!keyModel) {
      continue;
    }
    if (keyModel === modelPart) {
      return { type: "matched", key };
    }
  }

  const candidates: string[] = [];
  for (const key of litellmKeys) {
    const keyModel = normalizeModelPart(key);
    if (!keyModel) {
      continue;
    }
    if (keyModel.includes(modelPart) || modelPart.includes(keyModel)) {
      candidates.push(key);
    }
  }

  if (candidates.length === 1) {
    const candidate = candidates[0];
    if (candidate) {
      return { type: "matched", key: candidate };
    }
  }

  if (candidates.length > 1) {
    return { type: "ambiguous", candidates };
  }

  return { type: "unmatched" };
}

function hasManualPriceConfigured(pricing: Partial<ModelPricing> | undefined): boolean {
  if (!pricing) {
    return false;
  }
  return PRICING_VALUE_KEYS.some((key) => pricing[key] !== undefined);
}

function hasAnyManualPriceValue(pricing: Partial<ModelPricing> | undefined): boolean {
  if (!pricing) {
    return false;
  }
  return PRICING_VALUE_KEYS.some((key) => pricing[key] !== null);
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

const PRICING_CONFIG_KEYS = new Set([
  ...PRICING_VALUE_KEYS,
  "price_source",
  "litellm_key",
  "price_updated_at",
]);

function pickNonPricingConfig(configJson: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(configJson).filter(([key]) => !PRICING_CONFIG_KEYS.has(key)),
  );
}

async function syncModelPricingForProfiles(profileIds?: string[]): Promise<void> {
  const litellmData = await fetchLiteLLMPricing();
  const litellmKeys = Object.keys(litellmData);
  const activeRouteTargetsByKindAndAlias =
    await loadActiveRouteTargetsByKindAndAlias();

  let query = db
    .select({
      id: modelGatewayProfiles.id,
      kind: modelGatewayProfiles.kind,
      profileAlias: modelGatewayProfiles.profileAlias,
      modelAlias: modelGatewayProfiles.modelAlias,
      configJson: modelGatewayProfiles.configJson,
    })
    .from(modelGatewayProfiles)
    .where(eq(modelGatewayProfiles.isActive, true));

  if (profileIds && profileIds.length > 0) {
    query = db
      .select({
        id: modelGatewayProfiles.id,
        kind: modelGatewayProfiles.kind,
        profileAlias: modelGatewayProfiles.profileAlias,
        modelAlias: modelGatewayProfiles.modelAlias,
        configJson: modelGatewayProfiles.configJson,
      })
      .from(modelGatewayProfiles)
      .where(
        and(
          eq(modelGatewayProfiles.isActive, true),
          inArray(modelGatewayProfiles.id, profileIds),
        ),
      );
  }

  const profiles = await query;

  let updated = 0;
  let matched = 0;
  let unmatched = 0;
  let manualSkipped = 0;
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
    const existingPricing = existingConfigJson as Partial<ModelPricing>;

    if (
      (existingPricing?.price_source === "manual" ||
        existingPricing?.price_source === "openrouter") &&
      (hasManualPriceConfigured(existingPricing) || hasAnyManualPriceValue(existingPricing))
    ) {
      manualSkipped++;
      logger.info("Skipped manual pricing profile", {
        kind: profile.kind,
        profileAlias: profile.profileAlias,
        modelAlias: profile.modelAlias,
      });
      continue;
    }

    let match: ModelAliasMatch;
    if (existingPricing?.litellm_key) {
      presetKeyUsed++;
      if (litellmKeys.includes(existingPricing.litellm_key)) {
        match = { type: "matched", key: existingPricing.litellm_key };
      } else {
        invalidPresetKey++;
        match = { type: "unmatched" };
        logger.warn("Preset LiteLLM key is invalid, marked as unknown", {
          kind: profile.kind,
          profileAlias: profile.profileAlias,
          modelAlias: profile.modelAlias,
          litellmKey: existingPricing.litellm_key,
        });
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

      const newPricing: ModelPricing = {
        input_cost_per_token: normalizePriceNumber(litellmEntry.input_cost_per_token),
        output_cost_per_token: normalizePriceNumber(litellmEntry.output_cost_per_token),
        cache_read_input_token_cost: normalizePriceNumber(litellmEntry.cache_read_input_token_cost),
        cache_creation_input_token_cost: normalizePriceNumber(litellmEntry.cache_creation_input_token_cost),
        output_cost_per_reasoning_token: normalizePriceNumber(litellmEntry.output_cost_per_reasoning_token),
        input_cost_per_image_token: normalizePriceNumber(litellmEntry.input_cost_per_image_token),
        output_cost_per_image_token: normalizePriceNumber(litellmEntry.output_cost_per_image_token),
        input_cost_per_audio_token: normalizePriceNumber(litellmEntry.input_cost_per_audio_token),
        output_cost_per_audio_token: normalizePriceNumber(litellmEntry.output_cost_per_audio_token),
        input_cost_per_image: normalizePriceNumber(litellmEntry.input_cost_per_image),
        output_cost_per_image: normalizePriceNumber(litellmEntry.output_cost_per_image),
        price_source: "litellm",
        litellm_key: match.key,
        price_updated_at: new Date().toISOString(),
      };

      if (
        PRICING_VALUE_KEYS.some(
          (key) => existingPricing?.[key] !== newPricing[key],
        ) ||
        existingPricing?.price_source !== newPricing.price_source ||
        existingPricing?.litellm_key !== newPricing.litellm_key
      ) {
        await db
          .update(modelGatewayProfiles)
          .set({
            configJson: {
              ...pickNonPricingConfig(existingConfigJson),
              ...(newPricing as unknown as Record<string, unknown>),
            },
            updatedAt: new Date(),
          })
          .where(eq(modelGatewayProfiles.id, profile.id));
        updated++;
        logger.info("Updated model pricing", {
          kind: profile.kind,
          profileAlias: profile.profileAlias,
          modelAlias: profile.modelAlias,
          litellmKey: match.key,
          inputCost: newPricing.input_cost_per_token,
          outputCost: newPricing.output_cost_per_token,
        });
      }
    } else {
      unmatched++;
      if (match.type === "ambiguous") {
        logger.warn("LiteLLM price match is ambiguous, marked as unknown", {
          kind: profile.kind,
          profileAlias: profile.profileAlias,
          modelAlias: profile.modelAlias,
          routeTargets,
          candidates: match.candidates,
        });
      }
      if (existingPricing?.price_source !== "unknown") {
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
          price_updated_at: new Date().toISOString(),
        };
        await db
          .update(modelGatewayProfiles)
          .set({
            configJson: {
              ...pickNonPricingConfig(existingConfigJson),
              ...(unknownPricing as unknown as Record<string, unknown>),
            },
            updatedAt: new Date(),
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
    manualSkipped,
    presetKeyUsed,
    autoMatched,
    invalidPresetKey,
  });
}

export async function syncModelPricing(options?: {
  modelProfileIds?: string[];
}): Promise<void> {
  await syncModelPricingForProfiles(options?.modelProfileIds);
}

import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const isMainModule = process.argv[1] === __filename;

if (isMainModule) {
  syncModelPricing()
    .then(() => {
      logger.info("sync-model-pricing script completed");
    })
    .catch((error) => {
      logger.error("sync-model-pricing script failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDatabase();
    });
}
