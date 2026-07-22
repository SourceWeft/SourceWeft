import assert from "node:assert/strict";
import test from "node:test";
import {
  downgradeForcedToolChoiceInKwargs,
  normalizeToolChoiceForModel,
  planStructuredOutput,
  resolveModelCapabilities,
} from "../src/model-capabilities";
import type { ModelCapabilityRule } from "../src/types";

const RULES: ModelCapabilityRule[] = [
  { modelMatch: "deepseek-v4-pro", capabilities: { supportsForcedToolChoice: false } },
];

test("resolveModelCapabilities matches by case-insensitive substring", () => {
  for (const model of [
    "deepseek-v4-pro",
    "deepseek/deepseek-v4-pro",
    "openrouter/deepseek/DeepSeek-V4-Pro",
  ]) {
    assert.equal(
      resolveModelCapabilities(model, RULES).supportsForcedToolChoice,
      false,
      model,
    );
  }
});

test("resolveModelCapabilities: unmatched model and no rules fall to defaults", () => {
  assert.equal(
    resolveModelCapabilities("gpt-5", RULES).supportsForcedToolChoice,
    true,
  );
  assert.equal(
    resolveModelCapabilities("deepseek-v4-pro", undefined).supportsForcedToolChoice,
    true,
  );
});

test("resolveModelCapabilities: first matching rule wins per flag", () => {
  const rules: ModelCapabilityRule[] = [
    { modelMatch: "deepseek-v4-pro", capabilities: { supportsForcedToolChoice: true } }, // override first
    { modelMatch: "deepseek-v4-pro", capabilities: { supportsForcedToolChoice: false } },
  ];
  assert.equal(
    resolveModelCapabilities("deepseek-v4-pro", rules).supportsForcedToolChoice,
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

test("tool_choice: forced values downgrade to auto only when unsupported", () => {
  for (const forced of [
    "required",
    "any",
    "get_weather",
    { type: "function", function: { name: "get_weather" } },
  ]) {
    assert.equal(
      normalizeToolChoiceForModel({ toolChoice: forced, supportsForcedToolChoice: false }),
      "auto",
      JSON.stringify(forced),
    );
    assert.equal(
      normalizeToolChoiceForModel({ toolChoice: forced, supportsForcedToolChoice: true }),
      forced,
    );
  }
  for (const value of ["auto", "none", undefined]) {
    assert.equal(
      normalizeToolChoiceForModel({ toolChoice: value, supportsForcedToolChoice: false }),
      value,
    );
  }
});

test("kwargs downgrade rewrites tool_choice and leaves the rest intact", () => {
  assert.deepEqual(
    downgradeForcedToolChoiceInKwargs(
      { tool_choice: "required", parallel_tool_calls: false },
      { supportsForcedToolChoice: false },
    ),
    { tool_choice: "auto", parallel_tool_calls: false },
  );
  const kwargs = { tool_choice: "required" };
  assert.equal(
    downgradeForcedToolChoiceInKwargs(kwargs, { supportsForcedToolChoice: true }),
    kwargs,
  );
});
