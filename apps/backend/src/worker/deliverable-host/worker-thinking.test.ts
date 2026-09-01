import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveWorkerThinking } from "./context";

test("pipeline thinking is pinned off — the chat turn's 'auto' must not leak in", () => {
  // "auto" was the incident shape: for a thinking-by-default model it means
  // thinking ON, and a structured stage's whole token budget went to hidden
  // reasoning.
  const resolved = resolveWorkerThinking({
    llm: {
      executionMode: "GLOBAL",
      thinking: { mode: "auto", enabled: true, includeReasoning: true },
    } as Parameters<typeof resolveWorkerThinking>[0]["llm"],
  });
  assert.equal(resolved.mode, "off");
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.includeReasoning, false);
});

test("pipeline thinking keeps adapter hints while pinning off", () => {
  const resolved = resolveWorkerThinking({
    llm: {
      executionMode: "GLOBAL",
      thinking: { mode: "auto" },
    } as Parameters<typeof resolveWorkerThinking>[0]["llm"],
    profileConfig: {
      supportedParameters: ["reasoning", "include_reasoning"],
      supportedEfforts: ["high", "xhigh"],
    },
  });
  assert.equal(resolved.mode, "off");
  // The disable still has to be *expressible*: adapters translate "off" per
  // provider using these hints (OpenRouter needs `reasoning`).
  assert.deepEqual(resolved.supportedParameters, [
    "reasoning",
    "include_reasoning",
  ]);
  assert.deepEqual(resolved.supportedEfforts, ["high", "xhigh"]);
});

test("no llm config at all still resolves to off", () => {
  const resolved = resolveWorkerThinking({});
  assert.equal(resolved.mode, "off");
  assert.equal(resolved.enabled, false);
});
