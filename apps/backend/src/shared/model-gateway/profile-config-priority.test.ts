import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeOwnedProfileConfig,
  stripFormerlyProtectedProfileConfigFields,
  withProtectedProfileConfigFields,
} from "./profile-config-priority";

const ownedFields = new Set([
  "input_cost_per_token",
  "litellm_key",
  "price_source",
  "supportedEfforts",
  "supportedParameters",
]);

test("provider sync does not overwrite global-protected reasoning config", () => {
  const existing = withProtectedProfileConfigFields(
    {
      supportedEfforts: ["minimal", "low", "medium", "high", "xhigh"],
      supportedParameters: ["reasoning", "include_reasoning"],
    },
    ["supportedEfforts", "supportedParameters"],
  );

  const merged = mergeOwnedProfileConfig({
    configJson: existing,
    ownedFields,
    updates: {
      input_cost_per_token: 0.3,
      litellm_key: "sambanova/MiniMax-M2.7",
      price_source: "litellm",
      supportedEfforts: [],
      supportedParameters: ["tools", "tool_choice"],
    },
  });

  assert.deepEqual(merged.supportedParameters, [
    "reasoning",
    "include_reasoning",
  ]);
  assert.deepEqual(merged.supportedEfforts, [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.equal(merged.price_source, "litellm");
  assert.equal(merged.litellm_key, "sambanova/MiniMax-M2.7");
  assert.equal(merged.input_cost_per_token, 0.3);
});

test("provider sync fills capability fields when global did not protect them", () => {
  const merged = mergeOwnedProfileConfig({
    configJson: {
      targetModel: "provider/tool-model",
    },
    ownedFields,
    updates: {
      supportedEfforts: [],
      supportedParameters: ["tools", "tool_choice"],
    },
  });

  assert.deepEqual(merged.supportedParameters, ["tools", "tool_choice"]);
  assert.deepEqual(merged.supportedEfforts, []);
});

test("explicit global empty capability array blocks provider backfill", () => {
  const existing = withProtectedProfileConfigFields(
    {
      supportedParameters: [],
    },
    ["supportedParameters"],
  );

  const merged = mergeOwnedProfileConfig({
    configJson: existing,
    ownedFields,
    updates: {
      supportedParameters: ["tools"],
    },
  });

  assert.deepEqual(merged.supportedParameters, []);
});

test("removed global protection clears stale protected field before backfill", () => {
  const existing = withProtectedProfileConfigFields(
    {
      supportedParameters: ["reasoning"],
    },
    ["supportedParameters"],
  );

  const stripped = stripFormerlyProtectedProfileConfigFields(existing, []);
  const merged = mergeOwnedProfileConfig({
    configJson: stripped,
    ownedFields,
    updates: {
      supportedParameters: ["tools"],
    },
  });

  assert.deepEqual(merged.supportedParameters, ["tools"]);
});

test("locked pricing can still sync provider metadata without deleting prices", () => {
  const merged = mergeOwnedProfileConfig({
    configJson: {
      input_cost_per_token: 0.1,
      output_cost_per_token: 0.2,
      price_source: "openrouter",
      supportedParameters: ["reasoning"],
    },
    ownedFields: new Set(["supportedParameters"]),
    updates: {
      supportedParameters: ["tools"],
    },
  });

  assert.equal(merged.price_source, "openrouter");
  assert.equal(merged.input_cost_per_token, 0.1);
  assert.equal(merged.output_cost_per_token, 0.2);
  assert.deepEqual(merged.supportedParameters, ["tools"]);
});
