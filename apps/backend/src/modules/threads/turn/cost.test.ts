import assert from "node:assert/strict";
import { test } from "vitest";
import type { ModelPricing } from "@sourceweft/db";
import type { MeteredLlmCallTrace } from "./types";
import {
  resolveGatewayObservedIdentity,
  type LlmExecutionConfig,
} from "../../content/model-gateway-audit";
import { computeTurnProviderCost, testExports } from "./cost";

const basePricing: ModelPricing = {
  input_cost_per_token: 0.0000005,
  output_cost_per_token: 0.000003,
  cache_read_input_token_cost: null,
  cache_creation_input_token_cost: null,
  output_cost_per_reasoning_token: null,
  input_cost_per_image_token: null,
  output_cost_per_image_token: null,
  input_cost_per_audio_token: null,
  output_cost_per_audio_token: null,
  input_cost_per_image: null,
  output_cost_per_image: null,
  price_source: "litellm",
  litellm_key: "model",
  price_updated_at: new Date(0).toISOString(),
};

test("computeProviderCostFromPricing prefers provider actual cost", () => {
  const result = testExports.computeProviderCostFromPricing({
    pricing: basePricing,
    usage: {
      inputTokens: 200,
      outputTokens: 1120,
      outputImageTokens: 1120,
    },
    cost: {
      currency: "USD",
      inlineUsd: 0.0673,
      effectiveUsd: 0.0673,
      source: "provider_inline",
      status: "inline",
    },
  });

  assert.equal(result.providerCostUsd, 0.0673);
  assert.equal(result.costSource, "provider_actual");
  assert.deepEqual(result.missingPriceComponents, []);
});

test("computeProviderCostFromPricing blocks high risk image tokens without image price", () => {
  const result = testExports.computeProviderCostFromPricing({
    pricing: basePricing,
    usage: {
      inputTokens: 200,
      outputTokens: 1120,
      outputImageTokens: 1120,
    },
  });

  assert.equal(result.providerCostUsd, null);
  assert.equal(result.costSource, "missing_price_components");
  assert.deepEqual(result.missingPriceComponents, ["output_image_tokens"]);
});

test("computeProviderCostFromPricing blocks cache tokens without cache price", () => {
  const result = testExports.computeProviderCostFromPricing({
    pricing: basePricing,
    usage: {
      inputTokens: 200,
      outputTokens: 10,
      cacheReadTokens: 120,
    },
  });

  assert.equal(result.providerCostUsd, null);
  assert.equal(result.costSource, "missing_price_components");
  assert.deepEqual(result.missingPriceComponents, ["cache_read_tokens"]);
});

test("computeProviderCostFromPricing falls back when SiliconFlow returns reasoning tokens without cost", () => {
  const result = testExports.computeProviderCostFromPricing({
    pricing: {
      ...basePricing,
      input_cost_per_token: 0.0000002,
      output_cost_per_token: 0.000001,
      output_cost_per_reasoning_token: 0.000001,
    },
    usage: {
      inputTokens: 15,
      outputTokens: 255,
      reasoningTokens: 170,
    },
  });

  assert.equal(result.providerCostUsd, 0.000258);
  assert.equal(result.costSource, "price_book");
  assert.deepEqual(result.missingPriceComponents, []);
});

test("computeProviderCostFromPricing uses image token price when present", () => {
  const result = testExports.computeProviderCostFromPricing({
    pricing: {
      ...basePricing,
      output_cost_per_image_token: 0.00006,
    },
    usage: {
      inputTokens: 200,
      outputTokens: 1120,
      outputImageTokens: 1120,
    },
  });

  assert.equal(result.providerCostUsd, 0.0673);
  assert.equal(result.costSource, "price_book");
  assert.deepEqual(result.missingPriceComponents, []);
});

test("computeProviderCostFromPricing uses image token price without total token usage", () => {
  const result = testExports.computeProviderCostFromPricing({
    pricing: {
      ...basePricing,
      output_cost_per_image_token: 0.00006,
    },
    usage: {
      outputImageTokens: 1120,
    },
  });

  assert.equal(result.providerCostUsd, 0.0672);
  assert.equal(result.costSource, "price_book");
  assert.deepEqual(result.missingPriceComponents, []);
});

test("computeProviderCostFromPricing uses image count price without token usage", () => {
  const result = testExports.computeProviderCostFromPricing({
    pricing: {
      ...basePricing,
      output_cost_per_image: 0.04,
    },
    usage: {
      outputImageCount: 2,
    },
  });

  assert.equal(result.providerCostUsd, 0.08);
  assert.equal(result.costSource, "price_book");
  assert.deepEqual(result.missingPriceComponents, []);
});

test("computeProviderCostFromPricing prices a per-pixel image tier by quality + size", () => {
  const result = testExports.computeProviderCostFromPricing({
    pricing: {
      ...basePricing,
      output_cost_per_image: 0.04,
      image_pricing_tiers: [
        {
          quality: "hd",
          size: "1024x1024",
          perImage: null,
          perPixel: 7.629e-8,
        },
        {
          quality: "standard",
          size: "1024x1024",
          perImage: 0.04,
          perPixel: null,
        },
      ],
    },
    usage: {
      outputImageCount: 1,
      imageQuality: "hd",
      imageSize: "1024x1024",
    },
  });

  // hd tier wins over the flat 0.04: 7.629e-8 × 1024 × 1024.
  assert.equal(result.providerCostUsd, 7.629e-8 * 1024 * 1024);
  assert.equal(result.costSource, "price_book");
});

test("computeProviderCostFromPricing prices a per-image image tier and scales by count", () => {
  const result = testExports.computeProviderCostFromPricing({
    pricing: {
      ...basePricing,
      image_pricing_tiers: [
        { quality: "hd", size: "1024x1792", perImage: 0.12, perPixel: null },
      ],
    },
    usage: {
      outputImageCount: 2,
      imageQuality: "hd",
      imageSize: "1024x1792",
    },
  });

  assert.equal(result.providerCostUsd, 0.24);
  assert.equal(result.costSource, "price_book");
});

test("computeProviderCostFromPricing falls back to the flat image price when no tier matches", () => {
  const result = testExports.computeProviderCostFromPricing({
    pricing: {
      ...basePricing,
      output_cost_per_image: 0.04,
      image_pricing_tiers: [
        {
          quality: "hd",
          size: "1024x1024",
          perImage: null,
          perPixel: 7.629e-8,
        },
      ],
    },
    usage: {
      outputImageCount: 1,
      imageQuality: "standard",
      imageSize: "512x512",
    },
  });

  assert.equal(result.providerCostUsd, 0.04);
  assert.equal(result.costSource, "price_book");
});

test("computeProviderCostFromPricing ignores image tiers for token-billed gpt-image usage", () => {
  const result = testExports.computeProviderCostFromPricing({
    pricing: {
      ...basePricing,
      output_cost_per_image_token: 0.00004,
      image_pricing_tiers: [
        { quality: "high", size: "1024x1024", perImage: 0.167, perPixel: null },
      ],
    },
    usage: {
      inputTokens: 10,
      outputImageTokens: 4160,
      // gpt-image responses still report a rendered image count; the token
      // price must win and the per-image tier must not double-charge.
      outputImageCount: 1,
      imageQuality: "high",
      imageSize: "1024x1024",
    },
  });

  assert.equal(result.providerCostUsd, 0.166405);
  assert.equal(result.costSource, "price_book");
});

function trace(overrides: Partial<MeteredLlmCallTrace>): MeteredLlmCallTrace {
  return {
    id: "call",
    operation: "chat",
    modelKind: "chat",
    modelAlias: "chat-default",
    profileAlias: "chat-default",
    gatewayConfigId: "gateway",
    billingStatus: "metered",
    consumedCredits: 0,
    idempotencyKey: "key",
    referenceId: "ref",
    ...overrides,
  };
}

const lookups = {
  isGatewayByok: async () => false,
  getProfilePricing: async () => basePricing,
};

test("a turn's provider cost is the sum of its calls, each costed on its own", async () => {
  const result = await computeTurnProviderCost({
    lookups,
    calls: [
      // Billed with a total the provider reported.
      trace({ providerCostUsd: 0.01, costSource: "provider_actual" }),
      // Covered, so never billed: costed from the price book here.
      // 200·0.0000005 + 100·0.000003 = 0.0001 + 0.0003 = 0.0004
      trace({
        billingStatus: "covered",
        usage: { inputTokens: 200, outputTokens: 100 },
      }),
    ],
  });
  assert.equal(result.providerCostUsd, 0.0104);
  assert.equal(result.costSource, "mixed");
  assert.deepEqual(result.missingPriceComponents, []);
});

test("an uncostable call is listed rather than priced as the turn's chat model", async () => {
  const result = await computeTurnProviderCost({
    lookups: {
      isGatewayByok: async () => false,
      getProfilePricing: async () => ({
        ...basePricing,
        output_cost_per_token: null,
      }),
    },
    calls: [
      trace({ providerCostUsd: 0.002, costSource: "price_book" }),
      trace({
        billingStatus: "skipped",
        usage: { inputTokens: 10, outputTokens: 10 },
      }),
    ],
  });
  assert.equal(result.providerCostUsd, 0.002);
  assert.equal(result.costSource, "mixed");
  assert.deepEqual(result.missingPriceComponents, ["output_text_tokens"]);
});

test("a turn without model calls has no provider cost", async () => {
  const result = await computeTurnProviderCost({ lookups, calls: [] });
  assert.equal(result.providerCostUsd, null);
  assert.equal(result.costSource, "missing_usage");
});

test("a single billed call keeps its own source and price snapshot", async () => {
  const result = await computeTurnProviderCost({
    lookups,
    calls: [
      trace({
        providerCostUsd: 0.003,
        costSource: "price_book",
        pricingSnapshot: { input_cost_per_token: 0.0000005 },
      }),
    ],
  });
  assert.equal(result.providerCostUsd, 0.003);
  assert.equal(result.costSource, "price_book");
  assert.deepEqual(result.pricingSnapshot, { input_cost_per_token: 0.0000005 });
});

// A BYOK call's trace as settleModelCall records it: the observed identity
// replaces the profile with a `byok:` alias.
function byokTrace(overrides: Partial<MeteredLlmCallTrace> = {}) {
  const identity = resolveGatewayObservedIdentity({
    llm: {
      executionMode: "BYOK",
      providerModel: "gpt-5.1",
      byok: { provider: "openai" },
    } as LlmExecutionConfig,
    modelAlias: "chat-default",
    profileAlias: "chat-default",
  });
  return trace({
    modelAlias: identity.modelAlias,
    profileAlias: identity.profileAlias,
    usage: { inputTokens: 200, outputTokens: 100 },
    ...overrides,
  });
}

test("a BYOK call costs the platform nothing, whatever the billing module recorded", async () => {
  for (const call of [
    // Core edition: billing is not installed and never costed the call.
    byokTrace({
      billingStatus: "skipped",
      skipReason: "billing_not_installed",
      providerCostUsd: 0,
      costSource: "missing_or_zero_price",
    }),
    // Commercial edition: costed as BYOK, then skipped.
    byokTrace({
      billingStatus: "skipped",
      skipReason: "byok",
      providerCostUsd: 0,
      costSource: "byok",
    }),
    // Covered, with no billing figures at all.
    byokTrace({ billingStatus: "covered" }),
  ]) {
    const result = await computeTurnProviderCost({ lookups, calls: [call] });
    assert.equal(
      result.providerCostUsd,
      0,
      call.skipReason ?? call.billingStatus,
    );
    assert.equal(result.costSource, "byok");
  }
});

test("a BYOK turn still costs its platform calls, such as the title", async () => {
  const result = await computeTurnProviderCost({
    lookups,
    calls: [
      byokTrace({
        billingStatus: "skipped",
        skipReason: "byok",
        costSource: "byok",
        providerCostUsd: 0,
      }),
      // The title runs on a platform profile: 200·0.0000005 + 100·0.000003
      trace({
        billingStatus: "covered",
        profileAlias: "title-default",
        usage: { inputTokens: 200, outputTokens: 100 },
      }),
    ],
  });
  assert.equal(result.providerCostUsd, 0.0004);
  assert.equal(result.costSource, "mixed");
});
