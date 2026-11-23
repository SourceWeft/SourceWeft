import assert from "node:assert/strict";
import { test } from "vitest";
import {
  getProviderResponseAdapter,
  resolveModelGatewayConfig,
  resolveRequestTarget,
} from "@sourceweft/model-gateway";
import { buildRoutedModelGatewayConfig } from "./runtime";
import { buildStandaloneGatewayConfig } from "./standalone";

const PROVIDER = {
  id: "feature-service",
  providerName: "openrouter",
  providerKind: "openrouter" as const,
  baseUrl: "https://openrouter.ai/api/v1",
  model: "google/gemini-2.5-flash",
  apiKey: "test-key",
  supports: ["chat"],
  timeoutMs: 900_000,
  maxRetries: 0,
};

test("a standalone provider has no gateway row and is never BYOK", () => {
  const snapshot = buildStandaloneGatewayConfig(PROVIDER);
  assert.equal(snapshot.versionId, "standalone:feature-service");
  assert.deepEqual(Object.keys(snapshot.providers), ["openrouter"]);
  const provider = snapshot.providers.openrouter!;
  assert.equal(provider.gatewayConfigId, null);
  assert.equal(provider.isBYOK, false);
  assert.equal(provider.globalReady, true);
  assert.equal(provider.apiKey, "test-key");
  assert.equal(provider.timeoutMs, 900_000);
  assert.equal(provider.maxRetries, 0);
  assert.equal(provider.defaultHeaders["X-OpenRouter-Title"], "SourceWeft");
});

test("its one route, under the feature's id, resolves to the declared provider and model", async () => {
  const resolved = resolveModelGatewayConfig(
    buildRoutedModelGatewayConfig(buildStandaloneGatewayConfig(PROVIDER)),
  );
  const target = await resolveRequestTarget(resolved, {
    model: "feature-service",
    profileAlias: "feature-service",
  });
  assert.equal(target.provider, "openrouter");
  assert.equal(target.providerKind, "openrouter");
  // Billing reads the provider's reported cost through this adapter; under
  // the feature's id the lookup misses and the call is billed the minimum.
  assert.ok(getProviderResponseAdapter(target.provider));
  assert.equal(target.providerModel, "google/gemini-2.5-flash");
  assert.equal(target.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(target.apiKey, "test-key");
  assert.equal(target.timeoutMs, 900_000);
  assert.equal(target.maxRetries, 0);
});
