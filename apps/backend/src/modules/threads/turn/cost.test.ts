import assert from "node:assert/strict";
import { test } from "vitest";
import type { ModelPricing } from "@sourceweft/db";
import { testExports } from "./cost";

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
      providerCostUsd: 0.0673,
      providerCostSource: "provider_inline",
      providerCostSourcePath: "provider:openrouter.usage.cost",
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
