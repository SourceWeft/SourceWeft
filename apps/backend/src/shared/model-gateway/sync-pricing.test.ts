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
    syncPricing.testExports.isLiteLLMManagedPriceSource("openrouter"),
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
    syncPricing.testExports.isLiteLLMManagedPriceSource(undefined),
    true,
  );
  assert.equal(syncPricing.testExports.isLiteLLMManagedPriceSource(null), true);
  assert.equal(syncPricing.testExports.isLiteLLMManagedPriceSource(""), true);
  assert.equal(
    syncPricing.testExports.isLiteLLMManagedPriceSource("unknown"),
    true,
  );
  assert.equal(
    syncPricing.testExports.isLiteLLMManagedPriceSource("litellm"),
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

  const updates = syncPricing.testExports.buildLiteLLMSyncUpdates({
    litellmEntry: {
      input_cost_per_token: 9,
      output_cost_per_token: 10,
      litellm_provider: "provider",
      mode: "chat",
      supports_function_calling: true,
    },
    litellmKey: "provider/model",
    now: new Date(0),
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
