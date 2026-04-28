import type { ModelPricing } from "../db/schema-types";
import type { GlobalProfilePricingEntry } from "./global-config";
import type { RuntimeModelGatewayProfile } from "./types";

export function buildProfilePricingConfigJson(
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

export function mapModelGatewayProfile<
  T extends {
    id: string;
    kind: RuntimeModelGatewayProfile["kind"];
    gatewayConfigId: string;
    profileAlias: string;
    modelAlias: string;
    requestedDimensions: number | null;
    vectorStrategy: "auto" | "exact" | "disabled";
    isDefault: boolean;
    isActive: boolean;
    configJson: Record<string, unknown> | null;
    createdAt: Date;
    updatedAt: Date;
  },
>(row: T): RuntimeModelGatewayProfile {
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
