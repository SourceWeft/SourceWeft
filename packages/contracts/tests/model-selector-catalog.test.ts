import assert from "node:assert/strict";
import test from "node:test";
import {
  listThreadModelSelectorCatalogResponseSchema,
  modelSelectorCatalogItemSchema,
} from "../src/model-catalog";

const selectorItem = {
  profileAlias: "global-openrouter-chat:openai/gpt-5",
  modelAlias: "openai/gpt-5",
  providerName: "openrouter",
  providerKind: "openrouter",
  targetModel: "openai/gpt-5",
  availableViaGlobal: true,
  availableViaByokProviders: ["openrouter"],
  displayName: "GPT-5",
  subtitle: "OpenAI",
  badges: ["Reasoning"],
  capabilities: {
    supportsThinking: true,
    supportsImageInput: true,
    supportedEfforts: ["low", "medium", "high"],
  },
};

test("model selector row accepts fields used by chat selection", () => {
  assert.deepEqual(modelSelectorCatalogItemSchema.parse(selectorItem), selectorItem);
});

test("model selector row strips pricing and repeated catalog flags", () => {
  const parsed = modelSelectorCatalogItemSchema.parse({
    ...selectorItem,
    kind: "llm",
    isDefault: true,
    isActive: true,
    pricing: { giant: "x".repeat(10_000) },
    capabilities: {
      ...selectorItem.capabilities,
      supportedParameters: ["reasoning_effort"],
      supportSources: ["model-catalog"],
      includeReasoning: true,
      reasoningEffort: true,
      reasoning: true,
      capabilityOwned: { values: ["kept"] },
    },
  }) as Record<string, unknown>;

  assert.equal("kind" in parsed, false);
  assert.equal("isDefault" in parsed, false);
  assert.equal("isActive" in parsed, false);
  assert.equal("pricing" in parsed, false);
  const capabilities = parsed.capabilities as Record<string, unknown>;
  assert.equal("supportedParameters" in capabilities, false);
  assert.equal("supportSources" in capabilities, false);
  assert.equal("includeReasoning" in capabilities, false);
  assert.equal("reasoningEffort" in capabilities, false);
  assert.equal("reasoning" in capabilities, false);
  assert.deepEqual(capabilities.capabilityOwned, { values: ["kept"] });
});

test("model selector catalog preserves defaults and kind buckets", () => {
  const parsed = listThreadModelSelectorCatalogResponseSchema.parse({
    defaults: {
      llmProfileAlias: "chat-default",
      imageProfileAlias: "image-default",
      visionProfileAlias: "vision-default",
      llmModelAlias: "chat-default",
      imageModelAlias: "image-default",
      visionModelAlias: "vision-default",
    },
    kinds: { llm: [selectorItem], image: [], vision: [] },
  });

  assert.equal(parsed.kinds.llm[0]?.profileAlias, selectorItem.profileAlias);
  assert.equal(parsed.defaults.llmProfileAlias, "chat-default");
});
