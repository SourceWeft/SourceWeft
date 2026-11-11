import assert from "node:assert/strict";
import { test } from "vitest";
import {
  projectThreadModelSelectorCatalog,
  selectCatalogRouteTargets,
} from "./model-catalog";

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
    providerDisplayName: "Provider",
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
      capabilityOwned: { values: ["kept"] },
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
  assert.equal(row.providerDisplayName, "Provider");
  assert.equal(
    (row.capabilities as { supportsThinking: boolean }).supportsThinking,
    true,
  );
  assert.equal("pricing" in row, false);
  assert.equal("kind" in row, false);
  assert.equal("isActive" in row, false);
  assert.equal("isDefault" in row, false);
  const capabilities = row.capabilities as Record<string, unknown>;
  assert.equal("supportedParameters" in capabilities, false);
  assert.equal("supportSources" in capabilities, false);
  assert.equal("includeReasoning" in capabilities, false);
  assert.equal("reasoningEffort" in capabilities, false);
  assert.equal("reasoning" in capabilities, false);
  assert.deepEqual(capabilities.capabilityOwned, { values: ["kept"] });
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

function routeTarget(
  targetProviderName: string,
  priority: number,
  overrides: { alias?: string; weight?: number } = {},
) {
  return {
    routeKind: "chat",
    alias: overrides.alias ?? "profile",
    targetProviderName,
    targetModel: `${targetProviderName}/model`,
    priority,
    weight: overrides.weight ?? 0,
  };
}

test("a profile whose only route target is not globally ready is unavailable", () => {
  const selected = selectCatalogRouteTargets(
    [routeTarget("disabled", 1)],
    new Map([["disabled", false]]),
  );

  assert.equal(selected.get("chat:profile")?.globalReady, false);
  assert.equal(selected.get("chat:profile")?.targetProviderName, "disabled");
});

test("a ready fallback target makes the profile available and is the one reported", () => {
  const selected = selectCatalogRouteTargets(
    [routeTarget("ready", 2), routeTarget("disabled", 1)],
    new Map([
      ["disabled", false],
      ["ready", true],
    ]),
  );

  assert.equal(selected.get("chat:profile")?.globalReady, true);
  assert.equal(selected.get("chat:profile")?.targetProviderName, "ready");
  assert.equal(selected.get("chat:profile")?.targetModel, "ready/model");
});

test("the first ready target in routing order is reported", () => {
  const selected = selectCatalogRouteTargets(
    [
      routeTarget("second", 2),
      routeTarget("light", 1, { weight: 1 }),
      routeTarget("heavy", 1, { weight: 5 }),
    ],
    new Map([
      ["second", true],
      ["light", true],
      ["heavy", true],
    ]),
  );

  assert.equal(selected.get("chat:profile")?.targetProviderName, "heavy");
});

test("a provider missing from the active version counts as not ready", () => {
  const selected = selectCatalogRouteTargets(
    [routeTarget("unknown", 1), routeTarget("ready", 1, { alias: "other" })],
    new Map([["ready", true]]),
  );

  assert.equal(selected.get("chat:profile")?.globalReady, false);
  assert.equal(selected.get("chat:other")?.globalReady, true);
});
