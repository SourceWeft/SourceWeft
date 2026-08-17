import assert from "node:assert/strict";
import test from "node:test";
import {
  filterDisabledParams,
  forcedToolChoiceDisabled,
  planStructuredOutput,
  resolveModelCapabilities,
} from "../src/model-capabilities";
import type { ModelCapabilityRule } from "../src/types";

test("filterDisabledParams mirrors python disabled_params: null drops, list drops matching value", () => {
  // null → param dropped entirely.
  assert.deepEqual(
    filterDisabledParams(
      { tool_choice: { type: "function" }, temperature: 0 },
      { tool_choice: null },
    ),
    { temperature: 0 },
  );
  // list → dropped only when the current value is listed; other values kept.
  assert.deepEqual(
    filterDisabledParams({ reasoning_effort: "high" }, { reasoning_effort: ["low"] }),
    { reasoning_effort: "high" },
  );
  assert.deepEqual(
    filterDisabledParams({ reasoning_effort: "low" }, { reasoning_effort: ["low"] }),
    {},
  );
  // no disabledParams / absent param → same reference, no change.
  const kwargs = { tool_choice: "auto" };
  assert.equal(filterDisabledParams(kwargs, undefined), kwargs);
  assert.equal(filterDisabledParams(kwargs, { parallel_tool_calls: null }), kwargs);
});

test("forcedToolChoiceDisabled is true only when tool_choice is disabled entirely", () => {
  assert.equal(forcedToolChoiceDisabled({ tool_choice: null }), true);
  assert.equal(forcedToolChoiceDisabled({ tool_choice: ["required"] }), false);
  assert.equal(forcedToolChoiceDisabled({ parallel_tool_calls: null }), false);
  assert.equal(forcedToolChoiceDisabled(undefined), false);
});

const RULES: ModelCapabilityRule[] = [
  { modelMatch: "deepseek-v4-pro", capabilities: { disabledParams: { tool_choice: null } } },
];

test("resolveModelCapabilities matches by case-insensitive substring", () => {
  for (const model of [
    "deepseek-v4-pro",
    "deepseek/deepseek-v4-pro",
    "openrouter/deepseek/DeepSeek-V4-Pro",
  ]) {
    assert.deepEqual(
      resolveModelCapabilities(model, RULES).disabledParams,
      { tool_choice: null },
      model,
    );
  }
});

test("resolveModelCapabilities: unmatched model and no rules fall to defaults", () => {
  assert.equal(resolveModelCapabilities("gpt-5", RULES).disabledParams, undefined);
  assert.equal(
    resolveModelCapabilities("deepseek-v4-pro", undefined).disabledParams,
    undefined,
  );
});

test("resolveModelCapabilities: first matching rule wins per flag", () => {
  const rules: ModelCapabilityRule[] = [
    { modelMatch: "deepseek-v4-pro", capabilities: { toolCallArgumentJsonRepair: true } }, // override first
    { modelMatch: "deepseek-v4-pro", capabilities: { toolCallArgumentJsonRepair: false } },
  ];
  assert.equal(
    resolveModelCapabilities("deepseek-v4-pro", rules).toolCallArgumentJsonRepair,
    true,
  );
});

test("plan: no forced tool_choice → available tool; else structured", () => {
  assert.deepEqual(planStructuredOutput({ supportsForcedToolChoice: false }), {
    strategy: "availableTool",
  });
  assert.deepEqual(planStructuredOutput({ supportsForcedToolChoice: true }), {
    strategy: "structured",
  });
});

test("plan: a caller-pinned method is authoritative, capability ignored", () => {
  assert.deepEqual(
    planStructuredOutput({
      method: "json_mode",
      strict: true,
      supportsForcedToolChoice: false,
    }),
    { strategy: "structured", method: "json_mode", strict: true },
  );
});

