import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildRouteConstraintsJson,
  mergeGlobalProfileConfigJson,
} from "./config-sync";
import { resolveLiteLLMCapabilities } from "./litellm-capabilities";
import {
  readProtectedProfileConfigFields,
  withProtectedProfileConfigFields,
} from "./profile-config-priority";

const now = new Date("2026-05-21T00:00:00.000Z");

function configValue(config: Record<string, unknown>, key: string) {
  return config[key];
}

test("buildRouteConstraintsJson writes provider routing to route constraints", () => {
  assert.deepEqual(
    buildRouteConstraintsJson({
      providerRouting: {
        only: ["deepseek"],
        sort: "latency",
      },
    }),
    {
      providerRouting: {
        only: ["deepseek"],
        sort: "latency",
      },
    },
  );
  assert.deepEqual(buildRouteConstraintsJson({}), {});
});

test("mergeGlobalProfileConfigJson preserves existing pricing when pricing is omitted", () => {
  const merged = mergeGlobalProfileConfigJson({
    existing: true,
    existingConfigJson: {
      input_cost_per_token: 0.1,
      output_cost_per_token: 0.2,
      price_source: "manual",
      targetModel: "old-model",
    },
    entry: {
      targetModel: "new-model",
    },
    now,
  });

  assert.equal(configValue(merged, "targetModel"), "new-model");
  assert.equal(configValue(merged, "price_source"), "manual");
  assert.equal(configValue(merged, "input_cost_per_token"), 0.1);
  assert.equal(configValue(merged, "output_cost_per_token"), 0.2);
});

test("mergeGlobalProfileConfigJson clears existing pricing when pricing is null", () => {
  const merged = mergeGlobalProfileConfigJson({
    existing: true,
    existingConfigJson: {
      input_cost_per_token: 0.1,
      output_cost_per_token: 0.2,
      price_source: "manual",
      targetModel: "old-model",
    },
    entry: {
      pricing: null,
      targetModel: "new-model",
    },
    now,
  });

  assert.equal(configValue(merged, "targetModel"), "new-model");
  assert.equal(configValue(merged, "price_source"), "unknown");
  assert.equal(configValue(merged, "input_cost_per_token"), null);
  assert.equal(configValue(merged, "output_cost_per_token"), null);
  assert.equal(configValue(merged, "litellm_key"), null);
});

test("mergeGlobalProfileConfigJson keeps litellm pricing presets explicit", () => {
  const merged = mergeGlobalProfileConfigJson({
    existing: true,
    existingConfigJson: {
      price_source: "manual",
      targetModel: "old-model",
    },
    entry: {
      pricing: {
        litellmKey: "openai/gpt-test",
      },
      targetModel: "new-model",
    },
    now,
  });

  assert.equal(configValue(merged, "price_source"), "litellm");
  assert.equal(configValue(merged, "litellm_key"), "openai/gpt-test");
  assert.equal(configValue(merged, "price_updated_at"), null);
});

test("mergeGlobalProfileConfigJson keeps manual pricing explicit", () => {
  const merged = mergeGlobalProfileConfigJson({
    existing: true,
    existingConfigJson: {
      price_source: "unknown",
      targetModel: "old-model",
    },
    entry: {
      pricing: {
        inputCostPerToken: 0.3,
        outputCostPerToken: 0.6,
      },
      targetModel: "new-model",
    },
    now,
  });

  assert.equal(configValue(merged, "price_source"), "manual");
  assert.equal(configValue(merged, "input_cost_per_token"), 0.3);
  assert.equal(configValue(merged, "output_cost_per_token"), 0.6);
  assert.equal(configValue(merged, "price_updated_at"), now.toISOString());
});

test("an unknown supportedEfforts value never enters protectedFields", () => {
  // LiteLLM carries no reasoning-effort information, so the catalog path leaves
  // supportedEfforts absent. It must not be written as an empty array and must
  // not be marked user-protected — that froze `[]` on every non-OpenRouter
  // model and blocked every later sync from correcting it.
  const merged = mergeGlobalProfileConfigJson({
    existing: false,
    existingConfigJson: {},
    entry: {
      supportedParameters: ["tools", "tool_choice"],
      targetModel: "gpt-test",
    },
    now,
  });

  assert.equal("supportedEfforts" in merged, false);
  assert.deepEqual(
    [...readProtectedProfileConfigFields(merged)],
    ["supportedParameters"],
  );
});

test("a known supportedEfforts value is still written and protected", () => {
  const merged = mergeGlobalProfileConfigJson({
    existing: false,
    existingConfigJson: {},
    entry: {
      supportedEfforts: ["low", "medium", "high"],
      targetModel: "gpt-test",
    },
    now,
  });

  assert.deepEqual(configValue(merged, "supportedEfforts"), [
    "low",
    "medium",
    "high",
  ]);
  assert.ok(readProtectedProfileConfigFields(merged).has("supportedEfforts"));
});

test("dropping supportedEfforts from the sync clears a previously frozen value", () => {
  const merged = mergeGlobalProfileConfigJson({
    existing: true,
    existingConfigJson: withProtectedProfileConfigFields(
      { supportedEfforts: [], targetModel: "gpt-test" },
      ["supportedEfforts"],
    ),
    entry: {
      targetModel: "gpt-test",
    },
    now,
  });

  assert.equal("supportedEfforts" in merged, false);
  assert.equal(readProtectedProfileConfigFields(merged).size, 0);
});

test("resolveLiteLLMCapabilities never reports supported efforts", () => {
  const capabilities = resolveLiteLLMCapabilities({
    mode: "chat",
    supports_function_calling: true,
    output_cost_per_reasoning_token: 0.000003,
  });

  assert.equal("supportedEfforts" in capabilities, false);
  assert.deepEqual(capabilities.supportedParameters, ["tools", "tool_choice"]);
});
