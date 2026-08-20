import assert from "node:assert/strict";
import { test } from "vitest";
import { ModelCatalogRegistry } from "./registry";
import type { ModelInfoOverride, NormalizedModelInfo } from "./types";

function info(o: Partial<NormalizedModelInfo> & { id: string }): NormalizedModelInfo {
  return {
    reasoning: false,
    reasoningEfforts: [],
    toolCall: false,
    structuredOutput: false,
    vision: false,
    sources: [],
    ...o,
  };
}

async function build(input: {
  litellm?: NormalizedModelInfo[];
  modelsDev?: NormalizedModelInfo[];
  overrides?: Record<string, ModelInfoOverride>;
}) {
  const registry = new ModelCatalogRegistry({
    litellm: async () => input.litellm ?? [],
    modelsDev: async () => input.modelsDev ?? [],
    overrides: () =>
      new Map(Object.entries(input.overrides ?? {})),
  });
  await registry.refresh();
  return registry;
}

test("resolve matches by exact id, bare name, and snapshot-stripped bare name", async () => {
  const registry = await build({
    modelsDev: [
      info({ id: "openai/gpt-5.6-luna", reasoning: true }),
      info({ id: "xai/grok-4.6", reasoning: true }),
      info({ id: "deepseek/deepseek-v4-pro", reasoning: true }),
    ],
  });
  // exact provider/model
  assert.equal(registry.resolve("openai/gpt-5.6-luna")?.reasoning, true);
  // bare name across a different provider prefix (grok/ vs xai/)
  assert.equal(registry.resolve("grok/grok-4.6")?.reasoning, true);
  // snapshot suffix stripped to the base model
  assert.equal(registry.resolve("deepseek/deepseek-v4-pro-0813")?.reasoning, true);
  // unknown → null (caller default-allows)
  assert.equal(registry.resolve("acme/does-not-exist"), null);
});

test("models.dev wins over litellm; both contribute fields", async () => {
  const registry = await build({
    litellm: [info({ id: "openai/x", reasoning: true, toolCall: true, sources: ["litellm"] })],
    // models.dev is primary; its fields win, but litellm's toolCall survives
    // where models.dev is silent (OR merge on booleans).
    modelsDev: [info({ id: "openai/x", reasoning: true, vision: true, sources: ["models.dev"] })],
  });
  const r = registry.resolve("openai/x");
  assert.equal(r?.vision, true, "models.dev field applied");
  assert.equal(r?.toolCall, true, "litellm field retained (OR merge)");
  assert.ok(r?.sources.includes("models.dev"));
});

test("startAutoRefresh is a no-op when disabled and idempotent otherwise", () => {
  const registry = new ModelCatalogRegistry({
    litellm: async () => [],
    modelsDev: async () => [],
    overrides: () => new Map(),
  });
  // interval <= 0 disables; must not throw or arm a timer.
  registry.startAutoRefresh(0);
  // idempotent: repeated calls don't stack timers or throw.
  registry.startAutoRefresh(60_000);
  registry.startAutoRefresh(60_000);
});

test("override applies on top and materializes routing slugs with no base", async () => {
  const registry = await build({
    modelsDev: [info({ id: "openai/gpt-4o-mini", toolCall: true })],
    overrides: {
      // correct a field on an existing model
      "openai/gpt-4o-mini": { reasoning: true },
      // a routing slug that exists in no source
      "orcarouter/auto": { modality: "chat", reasoning: true, toolCall: true },
      // steer a media model's modality
      "grok/grok-imagine-image": { modality: "image" },
    },
  });
  assert.equal(registry.resolve("openai/gpt-4o-mini")?.reasoning, true, "override corrects field");
  assert.equal(registry.resolve("openai/gpt-4o-mini")?.toolCall, true, "base field kept");
  const auto = registry.resolve("orcarouter/auto");
  assert.equal(auto?.modality, "chat");
  assert.equal(auto?.reasoning, true, "slug materialized from override alone");
  assert.equal(registry.resolve("grok/grok-imagine-image")?.modality, "image");
});
