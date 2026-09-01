import type { UsageInfo } from "@sourceweft/model-gateway";
import { and, eq } from "drizzle-orm";
import { logger } from "../../shared/logger";
import {
  db,
  modelGatewayConfigs,
  modelGatewayProfiles,
  type ImagePricingTier,
  type ModelPricing,
} from "@sourceweft/db";
import type { LlmExecutionConfig } from "./model-gateway-audit";
import type { ModelProfileKind } from "./types";

type PricingSnapshot = Omit<ModelPricing, "litellm_key">;

/**
 * The two config reads cost resolution needs, behind an interface so the caller
 * chooses its own freshness/latency trade-off.
 *
 * Billing must use the direct (uncached) lookups: `isGatewayByok` decides
 * whether a customer is charged at all, so a stale read is a wrong charge.
 * Best-effort consumers that run per generation rather than per billable call —
 * notably observability cost attribution — may use the cached variant.
 */
export type ProviderCostLookups = {
  isGatewayByok(gatewayConfigId: string): Promise<boolean>;
  getProfilePricing(
    modelKind: ModelProfileKind,
    profileAlias: string,
  ): Promise<ModelPricing | undefined>;
};

export const directProviderCostLookups: ProviderCostLookups = {
  async isGatewayByok(gatewayConfigId) {
    const [gatewayRow] = await db
      .select({ isBYOK: modelGatewayConfigs.isBYOK })
      .from(modelGatewayConfigs)
      .where(eq(modelGatewayConfigs.id, gatewayConfigId))
      .limit(1);
    return Boolean(gatewayRow?.isBYOK);
  },
  async getProfilePricing(modelKind, profileAlias) {
    const [profileRow] = await db
      .select({ configJson: modelGatewayProfiles.configJson })
      .from(modelGatewayProfiles)
      .where(
        and(
          eq(modelGatewayProfiles.kind, modelKind),
          eq(modelGatewayProfiles.profileAlias, profileAlias),
          eq(modelGatewayProfiles.isActive, true),
        ),
      )
      .limit(1);
    return profileRow?.configJson as ModelPricing | undefined;
  },
};

/**
 * In-process, per-key TTL memoisation of {@link directProviderCostLookups}.
 * Not shared across processes — API and worker each hold their own — and not
 * invalidated on config change, so a toggle takes up to `ttlMs` to be observed.
 * That is acceptable only for consumers where a stale value costs accuracy
 * rather than money.
 */
export function createCachedProviderCostLookups(
  ttlMs = 60_000,
  source: ProviderCostLookups = directProviderCostLookups,
): ProviderCostLookups {
  type Entry<T> = { value: T; expiresAt: number };
  const byok = new Map<string, Entry<boolean>>();
  const pricing = new Map<string, Entry<ModelPricing | undefined>>();

  async function memoize<T>(
    cache: Map<string, Entry<T>>,
    key: string,
    load: () => Promise<T>,
  ): Promise<T> {
    const entry = cache.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      return entry.value;
    }
    const value = await load();
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }

  return {
    isGatewayByok: (gatewayConfigId) =>
      memoize(byok, gatewayConfigId, () =>
        source.isGatewayByok(gatewayConfigId),
      ),
    getProfilePricing: (modelKind, profileAlias) =>
      memoize(pricing, `${modelKind}:${profileAlias}`, () =>
        source.getProfilePricing(modelKind, profileAlias),
      ),
  };
}

export type ProviderCostResult = {
  providerCostUsd: number | null;
  pricingSnapshot: PricingSnapshot | null;
  costSource:
    | "byok"
    | "provider_actual"
    | "price_book"
    | "missing_usage"
    | "missing_or_zero_price"
    | "missing_price_components"
    | "missing_provider_actual";
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
    input_cost_per_pixel: pricing.input_cost_per_pixel ?? null,
    output_cost_per_pixel: pricing.output_cost_per_pixel ?? null,
    image_pricing_tiers: pricing.image_pricing_tiers ?? null,
    price_source: pricing.price_source,
    price_updated_at: pricing.price_updated_at ?? null,
  };
}

/** Pixel count of a `WxH` size string, or null if unparseable. */
function parseSizePixels(size: string | undefined): number | null {
  if (!size) {
    return null;
  }
  const match = /^(\d+)\s*x\s*(\d+)$/i.exec(size.trim());
  if (!match) {
    return null;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width * height : null;
}

/**
 * Pick the per-image price tier for a request's quality + size, mirroring
 * LiteLLM's `{quality}/{WxH}/{model}` price-book lookup. A tier with `quality`
 * or `size` omitted is a wildcard that still matches; the most specific
 * matching tier wins (exact quality+size > size-only > quality-only > wildcard).
 * Returns null when no tier is compatible with the request.
 */
function selectImageTier(
  tiers: ImagePricingTier[],
  quality: string | undefined,
  size: string | undefined,
): ImagePricingTier | null {
  const q = quality?.trim().toLowerCase();
  const s = size?.trim().toLowerCase();
  const norm = (value?: string) => value?.trim().toLowerCase();
  let best: ImagePricingTier | null = null;
  let bestScore = -1;
  for (const tier of tiers) {
    const tierQ = norm(tier.quality);
    const tierS = norm(tier.size);
    // A defined dimension that disagrees with the request disqualifies the tier.
    if (tierQ !== undefined && tierQ !== q) {
      continue;
    }
    if (tierS !== undefined && tierS !== s) {
      continue;
    }
    const score = (tierQ !== undefined ? 2 : 0) + (tierS !== undefined ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = tier;
    }
  }
  return best;
}

/** Cost of `count` images at a tier: per-image, else per-pixel × area. */
function imageTierCost(
  tier: ImagePricingTier,
  size: string | undefined,
  count: number,
): number | null {
  if (typeof tier.perImage === "number" && Number.isFinite(tier.perImage)) {
    return tier.perImage * count;
  }
  if (typeof tier.perPixel === "number" && Number.isFinite(tier.perPixel)) {
    const pixels = parseSizePixels(tier.size ?? size);
    if (pixels === null) {
      return null;
    }
    return tier.perPixel * pixels * count;
  }
  return null;
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
}): Pick<
  ProviderCostResult,
  "providerCostUsd" | "costSource" | "missingPriceComponents"
> {
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
  const inputAudioTokens = clampCount(usage.inputAudioTokens, inputTokenBound);
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
    outputTokens - outputAudioTokens - outputImageTokens - reasoningTokens,
  );
  const pricedInputImageCount = inputImageTokens > 0 ? 0 : inputImageCount;
  const pricedOutputImageCount = outputImageTokens > 0 ? 0 : outputImageCount;
  // DALL·E-style per-image/per-pixel models price the output by request
  // quality + size (LiteLLM's `{quality}/{WxH}` tiers). Resolve the tier once;
  // gpt-image bills by tokens above and leaves outputImageCount at 0 here.
  const imageTiers = Array.isArray(input.pricing.image_pricing_tiers)
    ? input.pricing.image_pricing_tiers
    : [];
  const outputTier =
    pricedOutputImageCount > 0 && imageTiers.length > 0
      ? selectImageTier(imageTiers, usage.imageQuality, usage.imageSize)
      : null;
  const outputTierCost = outputTier
    ? imageTierCost(outputTier, usage.imageSize, pricedOutputImageCount)
    : null;
  const hasOutputImageCountPrice =
    pricedOutputImageCount > 0 &&
    (outputTierCost !== null ||
      priceValue(input.pricing, "output_cost_per_image") !== null);
  const textInputTokens =
    hasOutputImageCountPrice && inputImageTokens === 0 ? 0 : normalInputTokens;
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
  if (outputTierCost !== null) {
    providerCostUsd += outputTierCost;
  } else {
    providerCostUsd += addComponent({
      amount: pricedOutputImageCount,
      pricing: input.pricing,
      key: "output_cost_per_image",
      component: "output_images",
      missing,
    });
  }
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
  allowPriceBookFallback?: boolean;
  /** Defaults to exact, uncached reads. Billing must not override this. */
  lookups?: ProviderCostLookups;
}): Promise<ProviderCostResult> {
  if (input.llm?.executionMode === "BYOK") {
    return {
      providerCostUsd: 0,
      pricingSnapshot: null,
      costSource: "byok",
      missingPriceComponents: [],
    };
  }

  const lookups = input.lookups ?? directProviderCostLookups;

  if (await lookups.isGatewayByok(input.gatewayConfigId)) {
    return {
      providerCostUsd: 0,
      pricingSnapshot: null,
      costSource: "byok",
      missingPriceComponents: [],
    };
  }

  if (
    input.allowPriceBookFallback === false &&
    !(
      input.usage?.providerCostUsd !== undefined &&
      Number.isFinite(input.usage.providerCostUsd) &&
      input.usage.providerCostUsd >= 0
    )
  ) {
    return {
      providerCostUsd: null,
      pricingSnapshot: null,
      costSource: "missing_provider_actual",
      missingPriceComponents: [],
    };
  }

  const pricing = await lookups.getProfilePricing(
    input.modelKind,
    input.profileAlias,
  );
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
