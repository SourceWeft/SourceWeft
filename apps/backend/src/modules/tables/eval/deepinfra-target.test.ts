import assert from "node:assert/strict";
import { test } from "vitest";
import { buildDeepInfraEvalTarget } from "./deepinfra-target";

test("refuses to build without a DeepInfra key", () => {
  for (const apiKey of [undefined, "", "   "]) {
    assert.throws(
      () =>
        buildDeepInfraEvalTarget({ apiKey, structuredOutput: "as-production" }),
      /DEEPINFRA_API_KEY/,
    );
  }
});

test("as-production mirrors the production DeepInfra gateway and chat-default target", () => {
  const target = buildDeepInfraEvalTarget({
    apiKey: "k",
    structuredOutput: "as-production",
  });
  const provider = target.routed.providers.deepinfra!;
  assert.equal(provider.kind, "deepinfra");
  assert.equal(provider.baseUrl, "https://api.deepinfra.com/v1");
  assert.equal(provider.apiKey, "k");
  assert.equal(provider.globalReady, true);
  assert.equal(provider.timeoutMs, 30_000);
  assert.equal(provider.maxRetries, 2);
  assert.deepEqual(provider.supports, [
    "chat",
    "embeddings",
    "rerank",
    "asr",
    "tts",
    "image",
  ]);
  assert.deepEqual(Object.keys(target.routed.providers), ["deepinfra"]);

  const chatRoute = target.routed.modelRoutes[target.chat.modelAlias]!;
  assert.deepEqual(
    chatRoute.targets.map(({ provider, model }) => ({ provider, model })),
    [{ provider: "deepinfra", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017" }],
  );
  assert.equal(
    target.chat.providerModel,
    "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  );
  // Thinking off, with the production profile's support facts, so the adapter
  // sends reasoning_effort "none".
  assert.deepEqual(target.chat.thinking, {
    mode: "off",
    enabled: false,
    includeReasoning: false,
    supportedParameters: ["reasoning_effort"],
    supportedEfforts: ["minimal", "low", "medium", "high"],
  });

  const embedRoute = target.routed.modelRoutes[target.embedding.profileAlias]!;
  assert.deepEqual(
    embedRoute.targets.map(({ provider, model }) => ({ provider, model })),
    [{ provider: "deepinfra", model: "BAAI/bge-m3" }],
  );
  assert.equal(target.embedding.identity.requestedDimensions, 1024);
  assert.equal(target.embedding.identity.canonicalModel, "bge-m3");
});

test("strict adds json_schema_strict to the provider and nothing else", () => {
  const production = buildDeepInfraEvalTarget({
    apiKey: "k",
    structuredOutput: "as-production",
  });
  const strict = buildDeepInfraEvalTarget({
    apiKey: "k",
    structuredOutput: "strict",
  });
  assert.deepEqual(strict.routed.providers.deepinfra!.supports, [
    ...production.routed.providers.deepinfra!.supports,
    "json_schema_strict",
  ]);
  assert.deepEqual(strict.routed.modelRoutes, production.routed.modelRoutes);
  assert.deepEqual(strict.chat, production.chat);
});
