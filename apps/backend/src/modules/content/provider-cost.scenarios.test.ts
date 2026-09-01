import assert from "node:assert/strict";
import { test } from "vitest";
import type { ModelPricing } from "@sourceweft/db";
import type { UsageInfo } from "@sourceweft/model-gateway";
import {
  computeProviderCost,
  computeProviderCostFromPricing,
} from "./provider-cost";

// A full ModelPricing with everything null, overlaid with the fields a scenario
// needs — so each test states exactly the prices that participate.
function price(overrides: Partial<ModelPricing>): ModelPricing {
  return {
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
    image_pricing_tiers: null,
    price_source: "registry",
    litellm_key: null,
    price_updated_at: null,
    ...overrides,
  };
}

function cost(pricing: ModelPricing, usage: UsageInfo) {
  return computeProviderCostFromPricing({ pricing, usage });
}

// 1) Plain chat. 1000 in @ $2.5/1M + 500 out @ $10/1M.
//    1000·2.5e-6 + 500·10e-6 = 0.0025 + 0.005 = 0.0075
test("chat: input + output tokens", () => {
  const r = cost(
    price({ input_cost_per_token: 2.5e-6, output_cost_per_token: 10e-6 }),
    { inputTokens: 1000, outputTokens: 500 },
  );
  assert.equal(r.providerCostUsd, 0.0075);
  assert.equal(r.costSource, "price_book");
});

test("provider actual-cost policy bypasses the price book when inline cost is absent", async () => {
  let pricingReads = 0;
  const result = await computeProviderCost({
    gatewayConfigId: "gateway-orca",
    modelKind: "chat",
    profileAlias: "chat-default",
    usage: { inputTokens: 842, outputTokens: 5012 },
    allowPriceBookFallback: false,
    lookups: {
      isGatewayByok: async () => false,
      getProfilePricing: async () => {
        pricingReads += 1;
        return price({ input_cost_per_token: 1, output_cost_per_token: 1 });
      },
    },
  });

  assert.equal(pricingReads, 0);
  assert.equal(result.providerCostUsd, null);
  assert.equal(result.costSource, "missing_provider_actual");
});

// 2) Prompt caching. inputTokens=1000 splits into cacheRead 800, cacheWrite 100,
//    normal 100. 100·3e-6 + 800·0.3e-6 + 100·3.75e-6 + 200·15e-6
//    = 0.0003 + 0.00024 + 0.000375 + 0.003 = 0.003915
test("chat with prompt cache: input splits into normal/read/write", () => {
  const r = cost(
    price({
      input_cost_per_token: 3e-6,
      cache_read_input_token_cost: 0.3e-6,
      cache_creation_input_token_cost: 3.75e-6,
      output_cost_per_token: 15e-6,
    }),
    {
      inputTokens: 1000,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      outputTokens: 200,
    },
  );
  assert.equal(r.providerCostUsd, 0.003915);
  assert.equal(r.costSource, "price_book");
});

// 3) Reasoning with NO separate price → billed at the output rate.
//    output=2000 = reasoning 1500 + normal 500.
//    500·15e-6 (in) + 500·60e-6 (out) + 1500·60e-6 (reasoning@out)
//    = 0.0075 + 0.03 + 0.09 = 0.1275
test("reasoning tokens fall back to the output price when unpriced", () => {
  const r = cost(
    price({ input_cost_per_token: 15e-6, output_cost_per_token: 60e-6 }),
    { inputTokens: 500, outputTokens: 2000, reasoningTokens: 1500 },
  );
  assert.equal(r.providerCostUsd, 0.1275);
});

// 4) Reasoning WITH its own price.
//    500·15e-6 + 500·60e-6 + 1500·30e-6 = 0.0075 + 0.03 + 0.045 = 0.0825
test("reasoning tokens use their own price when present", () => {
  const r = cost(
    price({
      input_cost_per_token: 15e-6,
      output_cost_per_token: 60e-6,
      output_cost_per_reasoning_token: 30e-6,
    }),
    { inputTokens: 500, outputTokens: 2000, reasoningTokens: 1500 },
  );
  assert.equal(r.providerCostUsd, 0.0825);
});

// 5) Audio tokens split out of input/output.
//    normalIn 600, audioIn 400; normalOut 300, audioOut 200.
//    600·1e-6 + 400·2e-6 + 300·3e-6 + 200·4e-6
//    = 0.0006 + 0.0008 + 0.0009 + 0.0008 = 0.0031
test("audio tokens split out of input and output", () => {
  const r = cost(
    price({
      input_cost_per_token: 1e-6,
      output_cost_per_token: 3e-6,
      input_cost_per_audio_token: 2e-6,
      output_cost_per_audio_token: 4e-6,
    }),
    {
      inputTokens: 1000,
      inputAudioTokens: 400,
      outputTokens: 500,
      outputAudioTokens: 200,
    },
  );
  assert.equal(r.providerCostUsd, 0.0031);
});

// 6) gpt-image-1 (token-billed image output) — zero deviation vs OrcaRouter.
//    10·5e-6 + 4160·4e-5 = 0.00005 + 0.1664 = 0.166450
test("gpt-image-1: image tokens priced at the image-token rate", () => {
  const r = cost(
    price({ input_cost_per_token: 5e-6, output_cost_per_image_token: 4e-5 }),
    { inputTokens: 10, outputImageTokens: 4160, outputImageCount: 1 },
  );
  assert.equal(r.providerCostUsd, 0.16645);
});

// 7) gpt-image-1-mini — 10·2e-6 + 4160·8e-6 = 0.00002 + 0.03328 = 0.033300
test("gpt-image-1-mini: image tokens, zero deviation", () => {
  const r = cost(
    price({ input_cost_per_token: 2e-6, output_cost_per_image_token: 8e-6 }),
    { inputTokens: 10, outputImageTokens: 4160, outputImageCount: 1 },
  );
  assert.equal(r.providerCostUsd, 0.0333);
});

// 8) DALL·E-style per-pixel tier. hd/1024x1024 @ 7.629e-8/px.
//    7.629e-8 · 1024 · 1024 = 7.629e-8 · 1048576 = 0.07999586304
test("image per-pixel tier: perPixel × width × height × count", () => {
  const r = cost(
    price({
      output_cost_per_image: 0.04,
      image_pricing_tiers: [
        {
          quality: "hd",
          size: "1024x1024",
          perImage: null,
          perPixel: 7.629e-8,
        },
      ],
    }),
    { outputImageCount: 1, imageQuality: "hd", imageSize: "1024x1024" },
  );
  assert.equal(r.providerCostUsd, 0.07999586304);
});

// 9) DALL·E-style per-image tier, scaled by count. standard/1024x1024 @ $0.04.
//    0.04 · 2 = 0.08
test("image per-image tier: perImage × count", () => {
  const r = cost(
    price({
      image_pricing_tiers: [
        {
          quality: "standard",
          size: "1024x1024",
          perImage: 0.04,
          perPixel: null,
        },
      ],
    }),
    { outputImageCount: 2, imageQuality: "standard", imageSize: "1024x1024" },
  );
  assert.equal(r.providerCostUsd, 0.08);
});

// 10) Aggregator inline cost (OpenRouter) short-circuits everything.
test("provider_actual: usage.cost wins and ignores tokens/prices", () => {
  const r = cost(
    price({ input_cost_per_token: 999, output_cost_per_token: 999 }),
    { providerCostUsd: 0.0123, inputTokens: 99999, outputTokens: 99999 },
  );
  assert.equal(r.providerCostUsd, 0.0123);
  assert.equal(r.costSource, "provider_actual");
});

// 11) A missing component blocks the whole bill (no silent under-charge).
test("missing output price → null, not a partial charge", () => {
  const r = cost(price({ input_cost_per_token: 2.5e-6 }), {
    inputTokens: 1000,
    outputTokens: 500,
  });
  assert.equal(r.providerCostUsd, null);
  assert.equal(r.costSource, "missing_price_components");
  assert.deepEqual(r.missingPriceComponents, ["output_text_tokens"]);
});

// 12) Same usage, two providers' prices → two costs (provider scoping's point).
//     deepseek: 1000·0.435e-6 + 500·0.87e-6 = 0.000435 + 0.000435 = 0.00087
//     orcarouter: 1000·0.56e-6 + 500·1.12e-6 = 0.00056 + 0.00056 = 0.00112
test("provider-scoped prices yield provider-specific costs", () => {
  const usage: UsageInfo = { inputTokens: 1000, outputTokens: 500 };
  const deepseek = cost(
    price({ input_cost_per_token: 0.435e-6, output_cost_per_token: 0.87e-6 }),
    usage,
  );
  const orcarouter = cost(
    price({ input_cost_per_token: 0.56e-6, output_cost_per_token: 1.12e-6 }),
    usage,
  );
  assert.equal(deepseek.providerCostUsd, 0.00087);
  assert.equal(orcarouter.providerCostUsd, 0.00112);
});
