import assert from "node:assert/strict";
import { beforeAll, test, vi } from "vitest";

vi.mock("@sourceweft/db", () => ({
  db: {},
  modelGatewayConfigVersions: {},
  modelGatewayProfiles: {},
  modelGatewayRoutes: {},
}));

vi.mock("../config", () => ({
  config: {
    litellmPricingUrl: "https://example.test/litellm.json",
  },
}));

vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("./runtime", () => ({ loadRoutedGatewayConfig: vi.fn() }));

let syncPricing: typeof import("./sync-pricing");

beforeAll(async () => {
  syncPricing = await import("./sync-pricing");
});

test("externally managed pricing with finite price skips LiteLLM auto match", () => {
  const pricing = {
    price_source: "openrouter",
    input_cost_per_token: 0.00000015,
    output_cost_per_token: 0.0000006,
  };

  assert.equal(
    syncPricing.testExports.isAutoManagedPriceSource("openrouter"),
    false,
  );
  assert.equal(syncPricing.testExports.hasAnyFinitePriceValue(pricing), true);
  assert.equal(syncPricing.testExports.isExternallyManagedPricing(pricing), true);
  assert.equal(syncPricing.testExports.shouldSkipLiteLLMAutoMatch(pricing), true);
});

test("zero price is a valid external price value", () => {
  const pricing = {
    price_source: "manual",
    input_cost_per_token: 0.000000025,
    output_cost_per_token: 0,
  };

  assert.equal(syncPricing.testExports.hasAnyFinitePriceValue(pricing), true);
  assert.equal(syncPricing.testExports.isExternallyManagedPricing(pricing), true);
  assert.equal(syncPricing.testExports.shouldSkipLiteLLMAutoMatch(pricing), true);
});

test("unknown and litellm price sources remain LiteLLM managed", () => {
  assert.equal(
    syncPricing.testExports.isAutoManagedPriceSource(undefined),
    true,
  );
  assert.equal(syncPricing.testExports.isAutoManagedPriceSource(null), true);
  assert.equal(syncPricing.testExports.isAutoManagedPriceSource(""), true);
  assert.equal(
    syncPricing.testExports.isAutoManagedPriceSource("unknown"),
    true,
  );
  assert.equal(
    syncPricing.testExports.isAutoManagedPriceSource("litellm"),
    true,
  );

  assert.equal(
    syncPricing.testExports.isExternallyManagedPricing({
      price_source: "unknown",
      input_cost_per_token: 1,
    }),
    false,
  );
  assert.equal(
    syncPricing.testExports.isExternallyManagedPricing({
      price_source: "litellm",
      input_cost_per_token: 1,
    }),
    false,
  );
});

test("externally managed pricing with explicit LiteLLM key can sync capabilities without price overwrite", () => {
  const pricing = {
    input_cost_per_token: 0.1,
    output_cost_per_token: 0.2,
    price_source: "provider_catalog",
    litellm_key: "provider/model",
  };

  assert.equal(syncPricing.testExports.isExternallyManagedPricing(pricing), true);
  assert.equal(
    syncPricing.testExports.shouldSkipLiteLLMAutoMatch(pricing),
    false,
  );

  const updates = syncPricing.testExports.buildSyncUpdatesFromInfo({
    info: {
      id: "provider/model",
      modality: "chat",
      reasoning: false,
      reasoningEfforts: [],
      toolCall: true,
      structuredOutput: false,
      vision: false,
      pricing: { inputPerToken: 9, outputPerToken: 10 },
      sources: ["models.dev"],
    },
    now: new Date(0),
    // externally-managed pricing → only capabilities refresh, price untouched.
    pricingLocked: true,
  });

  assert.equal("input_cost_per_token" in updates, false);
  assert.equal("output_cost_per_token" in updates, false);
  assert.equal("price_source" in updates, false);
  assert.equal("litellm_key" in updates, false);

  const merged = syncPricing.mergeModelPricingSyncConfig({
    existingConfigJson: {
      ...pricing,
      supportedParameters: ["reasoning"],
    },
    pricingLocked: true,
    updates,
  });

  assert.equal(merged.input_cost_per_token, 0.1);
  assert.equal(merged.output_cost_per_token, 0.2);
  assert.equal(merged.price_source, "provider_catalog");
  assert.equal(merged.litellm_key, "provider/model");
  assert.deepEqual(merged.supportedParameters, ["tools", "tool_choice"]);
  assert.equal(merged.supports_function_calling, true);
});

test("speech prices from the catalog become the per-character and per-second price fields", () => {
  const base = {
    reasoning: false,
    reasoningEfforts: [],
    toolCall: false,
    structuredOutput: false,
    vision: false,
    sources: ["deepinfra"],
  };
  const tts = syncPricing.testExports.pricingConfigFromInfo(
    {
      ...base,
      id: "xiaomimimo/mimo-v2.5-tts",
      modality: "tts",
      pricing: { inputPerCharacter: 0 },
    },
    new Date(0),
  );
  // A free model keeps an explicit zero, so its cost is a known zero.
  assert.equal(tts.input_cost_per_character, 0);
  assert.equal(tts.input_cost_per_second, null);
  assert.equal(tts.price_source, "registry");

  const asr = syncPricing.testExports.pricingConfigFromInfo(
    {
      ...base,
      id: "openai/whisper-large-v3-turbo",
      pricing: { inputPerSecond: 0.00000333 },
    },
    new Date(0),
  );
  assert.equal(asr.input_cost_per_second, 0.00000333);
  assert.equal(asr.input_cost_per_character, null);
});

test("a declared catalog price is auto-managed, so a synced speech price replaces it", () => {
  // What `"pricing": { "litellmKey": "..." }` stores before the first sync.
  const declared = {
    input_cost_per_token: null,
    price_source: "litellm",
    litellm_key: "deepinfra/openai/whisper-large-v3-turbo",
  };
  assert.equal(
    syncPricing.testExports.isExternallyManagedPricing(declared),
    false,
  );
  const merged = syncPricing.mergeModelPricingSyncConfig({
    existingConfigJson: declared,
    updates: syncPricing.testExports.pricingConfigFromInfo(
      {
        id: "openai/whisper-large-v3-turbo",
        reasoning: false,
        reasoningEfforts: [],
        toolCall: false,
        structuredOutput: false,
        vision: false,
        pricing: { inputPerSecond: 0.00000333 },
        sources: ["deepinfra"],
      },
      new Date(0),
    ),
  });
  assert.equal(merged.input_cost_per_second, 0.00000333);
  assert.equal(merged.price_source, "registry");
});
