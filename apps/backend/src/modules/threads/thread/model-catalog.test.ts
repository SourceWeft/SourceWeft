import assert from "node:assert/strict";
import { test } from "vitest";
import { projectThreadModelSelectorCatalog } from "./model-catalog";

const defaults = {
  llmProfileAlias: "chat-default",
  imageProfileAlias: "image-default",
  visionProfileAlias: "vision-default",
  llmModelAlias: "chat-default",
  imageModelAlias: "image-default",
  visionModelAlias: "vision-default",
};

function fullEntry(index: number) {
  return {
    kind: "llm" as const,
    profileAlias: `profile-${index}`,
    modelAlias: `model-${index}`,
    isDefault: index === 0,
    isActive: true,
    providerName: "provider",
    providerKind: "openai-compatible",
    targetModel: `provider/model-${index}`,
    availableViaGlobal: true,
    availableViaByokProviders: ["provider"],
    displayName: `Model ${index}`,
    subtitle: "Provider",
    badges: ["Reasoning"],
    pricing: {
      giantUnusedBillingMetadata: "x".repeat(10_000),
    },
    capabilities: {
      supportsThinking: true,
      supportsImageInput: true,
      supportedParameters: ["reasoning_effort"],
      supportedEfforts: ["low", "medium", "high"] as Array<
        "minimal" | "low" | "medium" | "high" | "xhigh"
      >,
      reasoning: false,
      reasoningEffort: true,
      includeReasoning: false,
      supportSources: ["model-catalog"],
    },
  };
}

test("selector projection keeps UI capabilities and removes billing fields", () => {
  const projected = projectThreadModelSelectorCatalog({
    defaults,
    kinds: { llm: [fullEntry(0)], image: [], vision: [] },
  });
  const row = projected.kinds.llm[0] as Record<string, unknown>;

  assert.equal(row.profileAlias, "profile-0");
  assert.equal(
    (row.capabilities as { supportsThinking: boolean }).supportsThinking,
    true,
  );
  assert.equal("pricing" in row, false);
  assert.equal("kind" in row, false);
  assert.equal("isActive" in row, false);
  assert.equal("isDefault" in row, false);
});

test("representative selector catalog remains below the response threshold", () => {
  const projected = projectThreadModelSelectorCatalog({
    defaults,
    kinds: {
      llm: Array.from({ length: 500 }, (_, index) => fullEntry(index)),
      image: [],
      vision: [],
    },
  });

  assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 512 * 1024);
});
