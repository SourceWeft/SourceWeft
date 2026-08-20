import assert from "node:assert/strict";
import { test } from "vitest";
import {
  deriveSupportedEfforts,
  deriveSupportedParameters,
} from "./litellm-capabilities";

test("deriveSupportedParameters emits reasoning_effort only when supports_reasoning", () => {
  assert.ok(
    deriveSupportedParameters({ supports_reasoning: true }).includes(
      "reasoning_effort",
    ),
  );
  assert.equal(
    deriveSupportedParameters({ supports_function_calling: true }).includes(
      "reasoning_effort",
    ),
    false,
  );
});

test("deriveSupportedEfforts gates minimal/xhigh on their flags", () => {
  assert.deepEqual(deriveSupportedEfforts({ supports_reasoning: true }), [
    "low",
    "medium",
    "high",
  ]);
  assert.deepEqual(
    deriveSupportedEfforts({
      supports_reasoning: true,
      supports_minimal_reasoning_effort: true,
      supports_xhigh_reasoning_effort: true,
    }),
    ["minimal", "low", "medium", "high", "xhigh"],
  );
  assert.deepEqual(deriveSupportedEfforts({ supports_function_calling: true }), []);
});
