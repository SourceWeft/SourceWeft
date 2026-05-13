import type { UsageInfo } from "@sourceweft/model-gateway";
import { and, eq } from "drizzle-orm";
import { logger } from "../../../../shared/logger";
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
  costSource:
    | "byok"
    | "provider_actual"
    | "price_book"
    | "missing_usage"
    | "missing_or_zero_price"
    | "missing_price_components";
  missingPriceComponents: string[];
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
    input_cost_per_image_token: pricing.input_cost_per_image_token ?? null,
    output_cost_per_image_token: pricing.output_cost_per_image_token ?? null,
    input_cost_per_audio_token: pricing.input_cost_per_audio_token ?? null,
    output_cost_per_audio_token: pricing.output_cost_per_audio_token ?? null,
    input_cost_per_image: pricing.input_cost_per_image ?? null,
    output_cost_per_image: pricing.output_cost_per_image ?? null,
    price_source: pricing.price_source,
    price_updated_at: pricing.price_updated_at ?? null,
  };
}

function clampCount(value: number | undefined, max?: number) {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const integer = Math.floor(value);
  return max === undefined ? integer : Math.min(integer, Math.max(0, max));
}

function knownBound(value: number) {
  return value > 0 ? value : undefined;
}

function priceValue(
  pricing: ModelPricing,
  key: keyof ModelPricing,
): number | null {
  const value = pricing[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function addComponent(input: {
  amount: number;
  pricing: ModelPricing;
  key: keyof ModelPricing;
  component: string;
  missing: Set<string>;
  missingMeansZero?: boolean;
}) {
  if (input.amount <= 0) {
    return 0;
  }
  const price = priceValue(input.pricing, input.key);
  if (price === null) {
    if (!input.missingMeansZero) {
      input.missing.add(input.component);
    }
    return 0;
  }
  return input.amount * price;
}

function roundUsd(value: number) {
  return Number(value.toFixed(12));
}

export function computeProviderCostFromPricing(input: {
  usage?: UsageInfo;
  pricing: ModelPricing;
}): Pick<ProviderCostResult, "providerCostUsd" | "costSource" | "missingPriceComponents"> {
  const usage = input.usage;
  if (!usage) {
    return {
      providerCostUsd: null,
      costSource: "missing_usage",
      missingPriceComponents: [],
    };
  }

  if (
    usage.providerCostUsd !== undefined &&
    Number.isFinite(usage.providerCostUsd) &&
    usage.providerCostUsd >= 0
  ) {
    return {
      providerCostUsd: roundUsd(usage.providerCostUsd),
      costSource: "provider_actual",
      missingPriceComponents: [],
    };
  }

  const inputTokens = clampCount(usage.inputTokens);
  const outputTokens = clampCount(usage.outputTokens);
  const inputTokenBound = knownBound(inputTokens);
  const outputTokenBound = knownBound(outputTokens);
  const inputImageCount = clampCount(usage.inputImageCount);
  const outputImageCount = clampCount(usage.outputImageCount);
  const hasBillableUsage =
    inputTokens > 0 ||
    outputTokens > 0 ||
    inputImageCount > 0 ||
    outputImageCount > 0 ||
    clampCount(usage.cacheReadTokens) > 0 ||
    clampCount(usage.cacheWriteTokens) > 0 ||
    clampCount(usage.inputImageTokens) > 0 ||
    clampCount(usage.outputImageTokens) > 0 ||
    clampCount(usage.inputAudioTokens) > 0 ||
    clampCount(usage.outputAudioTokens) > 0;
  if (!hasBillableUsage) {
    return {
      providerCostUsd: null,
      costSource: "missing_usage",
      missingPriceComponents: [],
    };
  }

  const missing = new Set<string>();
  const cacheReadTokens = clampCount(usage.cacheReadTokens, inputTokenBound);
  const cacheWriteTokens = clampCount(
    usage.cacheWriteTokens,
    inputTokenBound ? inputTokens - cacheReadTokens : undefined,
  );
  const inputAudioTokens = clampCount(
    usage.inputAudioTokens,
    inputTokenBound,
  );
  const inputImageTokens = clampCount(
    usage.inputImageTokens,
    inputTokenBound
      ? inputTokens - cacheReadTokens - cacheWriteTokens - inputAudioTokens
      : undefined,
  );
  const normalInputTokens = Math.max(
    0,
    inputTokens -
      cacheReadTokens -
      cacheWriteTokens -
      inputAudioTokens -
      inputImageTokens,
  );

  const outputAudioTokens = clampCount(
    usage.outputAudioTokens,
    outputTokenBound,
  );
  const outputImageTokens = clampCount(
    usage.outputImageTokens,
    outputTokenBound ? outputTokens - outputAudioTokens : undefined,
  );
  const reasoningTokens = clampCount(
    usage.reasoningTokens,
    outputTokenBound
      ? outputTokens - outputAudioTokens - outputImageTokens
      : undefined,
  );
  const normalOutputTokens = Math.max(
    0,
    outputTokens -
      outputAudioTokens -
      outputImageTokens -
      reasoningTokens,
  );
  const pricedInputImageCount = inputImageTokens > 0 ? 0 : inputImageCount;
  const pricedOutputImageCount = outputImageTokens > 0 ? 0 : outputImageCount;
  const hasOutputImageCountPrice =
    pricedOutputImageCount > 0 &&
    priceValue(input.pricing, "output_cost_per_image") !== null;
  const textInputTokens =
    hasOutputImageCountPrice && inputImageTokens === 0
      ? 0
      : normalInputTokens;
  const textOutputTokens =
    hasOutputImageCountPrice && outputImageTokens === 0
      ? 0
      : normalOutputTokens;

  let providerCostUsd = 0;
  providerCostUsd += addComponent({
    amount: textInputTokens,
    pricing: input.pricing,
    key: "input_cost_per_token",
    component: "input_text_tokens",
    missing,
  });
  providerCostUsd += addComponent({
    amount: cacheReadTokens,
    pricing: input.pricing,
    key: "cache_read_input_token_cost",
    component: "cache_read_tokens",
    missing,
  });
  providerCostUsd += addComponent({
    amount: cacheWriteTokens,
    pricing: input.pricing,
    key: "cache_creation_input_token_cost",
    component: "cache_write_tokens",
    missing,
  });
  providerCostUsd += addComponent({
    amount: inputImageTokens,
    pricing: input.pricing,
    key: "input_cost_per_image_token",
    component: "input_image_tokens",
    missing,
  });
  providerCostUsd += addComponent({
    amount: pricedInputImageCount,
    pricing: input.pricing,
    key: "input_cost_per_image",
    component: "input_images",
    missing,
  });
  providerCostUsd += addComponent({
    amount: inputAudioTokens,
    pricing: input.pricing,
    key: "input_cost_per_audio_token",
    component: "input_audio_tokens",
    missing,
  });
  providerCostUsd += addComponent({
    amount: textOutputTokens,
    pricing: input.pricing,
    key: "output_cost_per_token",
    component: "output_text_tokens",
    missing,
  });
  providerCostUsd += addComponent({
    amount: reasoningTokens,
    pricing: input.pricing,
    key:
      priceValue(input.pricing, "output_cost_per_reasoning_token") === null
        ? "output_cost_per_token"
        : "output_cost_per_reasoning_token",
    component: "reasoning_tokens",
    missing,
  });
  providerCostUsd += addComponent({
    amount: outputImageTokens,
    pricing: input.pricing,
    key: "output_cost_per_image_token",
    component: "output_image_tokens",
    missing,
  });
  providerCostUsd += addComponent({
    amount: pricedOutputImageCount,
    pricing: input.pricing,
    key: "output_cost_per_image",
    component: "output_images",
    missing,
  });
  providerCostUsd += addComponent({
    amount: outputAudioTokens,
    pricing: input.pricing,
    key: "output_cost_per_audio_token",
    component: "output_audio_tokens",
    missing,
  });

  const missingPriceComponents = Array.from(missing);
  if (missingPriceComponents.length > 0) {
    return {
      providerCostUsd: null,
      costSource: "missing_price_components",
      missingPriceComponents,
    };
  }

  const rounded = roundUsd(providerCostUsd);
  return {
    providerCostUsd: rounded,
    costSource: rounded > 0 ? "price_book" : "missing_or_zero_price",
    missingPriceComponents,
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
    return {
      providerCostUsd: 0,
      pricingSnapshot: null,
      costSource: "byok",
      missingPriceComponents: [],
    };
  }

  const [gatewayRow] = await db
    .select({ isBYOK: modelGatewayConfigs.isBYOK })
    .from(modelGatewayConfigs)
    .where(eq(modelGatewayConfigs.id, input.gatewayConfigId))
    .limit(1);

  if (gatewayRow?.isBYOK) {
    return {
      providerCostUsd: 0,
      pricingSnapshot: null,
      costSource: "byok",
      missingPriceComponents: [],
    };
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
    const cost = computeProviderCostFromPricing({
      usage: input.usage,
      pricing: {
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
        price_updated_at: null,
      },
    });
    if (cost.missingPriceComponents.length > 0) {
      logger.warn("Model usage has missing price components", {
        modelKind: input.modelKind,
        profileAlias: input.profileAlias,
        missingPriceComponents: cost.missingPriceComponents,
        usage: input.usage,
      });
    }
    return {
      providerCostUsd: cost.providerCostUsd,
      pricingSnapshot: null,
      costSource: cost.costSource,
      missingPriceComponents: cost.missingPriceComponents,
    };
  }

  const pricingSnapshot = buildPricingSnapshot(pricing);
  const cost = computeProviderCostFromPricing({
    usage: input.usage,
    pricing,
  });
  if (cost.missingPriceComponents.length > 0) {
    logger.warn("Model usage has missing price components", {
      modelKind: input.modelKind,
      profileAlias: input.profileAlias,
      missingPriceComponents: cost.missingPriceComponents,
      usage: input.usage,
    });
  }

  return {
    providerCostUsd: cost.providerCostUsd,
    pricingSnapshot,
    costSource: cost.costSource,
    missingPriceComponents: cost.missingPriceComponents,
  };
}

export const testExports = {
  computeProviderCostFromPricing,
};
