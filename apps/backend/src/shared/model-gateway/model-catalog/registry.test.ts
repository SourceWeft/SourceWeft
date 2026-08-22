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

test("exact provider-prefixed id inherits image pricing from the bare-name union", async () => {
  // models.dev lists the image model under `openai/…` with no price; LiteLLM
  // carries the token price + per-image tiers under the bare / `azure/…` ids.
  // The two never share a byId key, so resolve must fold in the bare union.
  const registry = await build({
    litellm: [
      info({
        id: "azure/gpt-image-1",
        modality: "image",
        sources: ["litellm"],
        pricing: {
          inputImageTokenPerToken: 0.00001,
          outputImageTokenPerToken: 0.00004,
        },
      }),
      info({
        id: "gpt-image-1",
        modality: "image",
        sources: ["litellm"],
        pricing: {
          imageTiers: [{ quality: "high", size: "1024x1024", perImage: 0.167 }],
        },
      }),
    ],
    modelsDev: [
      info({ id: "openai/gpt-image-1", modality: "image", sources: ["models.dev"] }),
    ],
  });
  const r = registry.resolve("openai/gpt-image-1");
  assert.equal(r?.pricing?.outputImageTokenPerToken, 0.00004);
  assert.equal(r?.pricing?.imageTiers?.length, 1);
  assert.equal(r?.pricing?.imageTiers?.[0]?.perImage, 0.167);
});

test("resolve prices a shared model id from the serving provider's bucket", async () => {
  // The same model id is offered by three providers at different prices; the
  // global union alone would pick an arbitrary one.
  const priced = (provider: string, input: number) =>
    info({
      id: "deepseek/deepseek-v4-pro",
      provider,
      sources: ["models.dev"],
      pricing: { inputPerToken: input },
    });
  const registry = await build({
    modelsDev: [
      priced("deepseek", 0.435e-6),
      priced("orcarouter", 0.56e-6),
      priced("openrouter", 1.6e-6),
    ],
  });
  // provider hint selects that provider's price
  assert.equal(
    registry.resolve("deepseek/deepseek-v4-pro", { provider: "orcarouter" })
      ?.pricing?.inputPerToken,
    0.56e-6,
  );
  assert.equal(
    registry.resolve("deepseek/deepseek-v4-pro", { provider: "openrouter" })
      ?.pricing?.inputPerToken,
    1.6e-6,
  );
  // no hint: the id's own prefix ("deepseek/…") picks the deepseek bucket
  assert.equal(
    registry.resolve("deepseek/deepseek-v4-pro")?.pricing?.inputPerToken,
    0.435e-6,
  );
  // provider alias is normalized (together → togetherai)
  const aliased = await build({
    modelsDev: [
      info({
        id: "meta/llama-3",
        provider: "togetherai",
        sources: ["models.dev"],
        pricing: { inputPerToken: 9e-7 },
      }),
    ],
  });
  assert.equal(
    aliased.resolve("meta/llama-3", { provider: "together" })?.pricing
      ?.inputPerToken,
    9e-7,
  );
});

test("resolve chains provider signals: hint, then the id's vendor prefix", async () => {
  const registry = await build({
    modelsDev: [
      info({
        id: "openai/gpt-4o",
        provider: "openai",
        sources: ["models.dev"],
        pricing: { inputPerToken: 2.5e-6 },
      }),
      // a reseller gateway carrying the same id at its own price
      info({
        id: "openai/gpt-4o",
        provider: "cloudflare-ai-gateway",
        sources: ["models.dev"],
        pricing: { inputPerToken: 9e-6 },
      }),
    ],
  });
  // explicit hint wins when its bucket has the model
  assert.equal(
    registry.resolve("openai/gpt-4o", { provider: "cloudflare-ai-gateway" })
      ?.pricing?.inputPerToken,
    9e-6,
  );
  // hint bucket misses → fall through to the id's vendor prefix (openai)
  assert.equal(
    registry.resolve("openai/gpt-4o", { provider: "no-such-provider" })
      ?.pricing?.inputPerToken,
    2.5e-6,
  );
});

test("resolve with no provider falls back to LiteLLM's reference price", async () => {
  const registry = await build({
    litellm: [
      info({
        id: "gpt-4o",
        provider: "openai",
        sources: ["litellm"],
        pricing: { inputPerToken: 2.5e-6 },
      }),
    ],
    // a reseller listing the same bare id at a marked-up price
    modelsDev: [
      info({
        id: "gpt-4o",
        provider: "abacus",
        sources: ["models.dev"],
        pricing: { inputPerToken: 9e-6 },
      }),
    ],
  });
  // bare id, no provider hint, no prefix → LiteLLM's official price, not the
  // reseller price the global union would otherwise surface.
  assert.equal(
    registry.resolve("gpt-4o")?.pricing?.inputPerToken,
    2.5e-6,
  );
});

test("models.dev price wins over LiteLLM even when they use different id forms", async () => {
  // Real divergence: models.dev's `deepseek` block lists the bare id at its
  // official price; LiteLLM lists the vendor-prefixed id at a different price.
  // Querying the prefixed id must not let LiteLLM's exact-id match override the
  // primary source — the two only reconcile in the bare-name union.
  const registry = await build({
    litellm: [
      info({
        id: "deepseek/deepseek-v4-pro",
        provider: "deepseek",
        sources: ["litellm"],
        pricing: { inputPerToken: 1.32e-6, outputPerToken: 3.96e-6 },
      }),
    ],
    modelsDev: [
      info({
        id: "deepseek-v4-pro",
        provider: "deepseek",
        sources: ["models.dev"],
        pricing: { inputPerToken: 0.435e-6, outputPerToken: 0.87e-6 },
      }),
    ],
  });
  const p = registry.resolve("deepseek/deepseek-v4-pro", {
    provider: "deepseek",
  })?.pricing;
  assert.equal(p?.inputPerToken, 0.435e-6);
  assert.equal(p?.outputPerToken, 0.87e-6);
});

test("within a provider bucket, LiteLLM fills fields models.dev left null", async () => {
  const registry = await build({
    litellm: [
      info({
        id: "openai/gpt-x",
        provider: "openai",
        sources: ["litellm"],
        pricing: { inputPerToken: 1e-6, outputPerToken: 2e-6 },
      }),
    ],
    // models.dev (primary) has the model but hasn't filled the output price yet
    modelsDev: [
      info({
        id: "openai/gpt-x",
        provider: "openai",
        sources: ["models.dev"],
        pricing: { inputPerToken: 1.5e-6, outputPerToken: null },
      }),
    ],
  });
  const p = registry.resolve("openai/gpt-x", { provider: "openai" })?.pricing;
  // models.dev wins where it has a value; its null output falls back to LiteLLM
  assert.equal(p?.inputPerToken, 1.5e-6);
  assert.equal(p?.outputPerToken, 2e-6);
});

test("resolve with no provider and no LiteLLM entry uses the global union", async () => {
  const registry = await build({
    modelsDev: [
      info({
        id: "newmodel",
        provider: "abacus",
        sources: ["models.dev"],
        pricing: { inputPerToken: 9e-6 },
      }),
    ],
  });
  assert.equal(
    registry.resolve("newmodel")?.pricing?.inputPerToken,
    9e-6,
  );
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
