import type { UsageInfo } from "@sourceweft/model-gateway";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../shared/database";
import {
  modelGatewayConfigs,
  modelGatewayProfiles,
} from "../../../../shared/db/schema";
import type { ModelPricing } from "../../../../shared/db/schema-types";
import type { LlmExecutionConfig } from "../../model-gateway-audit";
import type { ModelProfileKind } from "../model-settings";

type PricingSnapshot = Omit<ModelPricing, "litellm_key">;

export type ProviderCostResult = {
  providerCostUsd: number | null;
  pricingSnapshot: PricingSnapshot | null;
};

function buildPricingSnapshot(pricing: ModelPricing): PricingSnapshot {
  return {
    input_cost_per_token: pricing.input_cost_per_token ?? null,
    output_cost_per_token: pricing.output_cost_per_token ?? null,
    cache_read_input_token_cost: pricing.cache_read_input_token_cost ?? null,
    cache_creation_input_token_cost:
      pricing.cache_creation_input_token_cost ?? null,
    output_cost_per_reasoning_token:
      pricing.output_cost_per_reasoning_token ?? null,
    price_source: pricing.price_source,
    price_updated_at: pricing.price_updated_at ?? null,
  };
}

export async function computeProviderCost(input: {
  gatewayConfigId: string;
  modelKind: ModelProfileKind;
  profileAlias: string;
  usage?: UsageInfo;
  llm?: LlmExecutionConfig;
}): Promise<ProviderCostResult> {
  if (input.llm?.executionMode === "BYOK") {
    return { providerCostUsd: 0, pricingSnapshot: null };
  }

  const [gatewayRow] = await db
    .select({ isBYOK: modelGatewayConfigs.isBYOK })
    .from(modelGatewayConfigs)
    .where(eq(modelGatewayConfigs.id, input.gatewayConfigId))
    .limit(1);

  if (gatewayRow?.isBYOK) {
    return { providerCostUsd: 0, pricingSnapshot: null };
  }

  const [profileRow] = await db
    .select({ configJson: modelGatewayProfiles.configJson })
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.kind, input.modelKind),
        eq(modelGatewayProfiles.profileAlias, input.profileAlias),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);

  const pricing = profileRow?.configJson as ModelPricing | undefined;
  if (!pricing || pricing.price_source === "unknown") {
    return { providerCostUsd: 0, pricingSnapshot: null };
  }

  const pricingSnapshot = buildPricingSnapshot(pricing);

  const usage = input.usage;
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  if (inputTokens === undefined || outputTokens === undefined) {
    return { providerCostUsd: null, pricingSnapshot };
  }

  const cacheReadTokens = usage?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage?.cacheWriteTokens ?? 0;

  const providerCostUsd =
    inputTokens * (pricing.input_cost_per_token ?? 0) +
    outputTokens * (pricing.output_cost_per_token ?? 0) +
    cacheReadTokens * (pricing.cache_read_input_token_cost ?? 0) +
    cacheWriteTokens * (pricing.cache_creation_input_token_cost ?? 0);

  return {
    providerCostUsd: Number(providerCostUsd.toFixed(6)),
    pricingSnapshot,
  };
}
