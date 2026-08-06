import assert from "node:assert/strict";
import test from "node:test";
import { resolveThinkingMode } from "../src/thinking";

test("resolveThinkingMode: explicit enabled:false beats a delegating 'auto' mode", () => {
  // The worker's disable intent must survive a passed-through "auto" — the
  // exact combination that let a chat turn's preference re-enable thinking on
  // a pipeline's structured call.
  assert.equal(
    resolveThinkingMode({ mode: "auto", enabled: false }),
    "off",
  );
  assert.equal(resolveThinkingMode({ enabled: false }), "off");
});

test("resolveThinkingMode: explicit modes stay authoritative", () => {
  assert.equal(resolveThinkingMode({ mode: "off" }), "off");
  assert.equal(
    resolveThinkingMode({ mode: "effort", enabled: false }),
    "effort",
  );
  assert.equal(resolveThinkingMode({ mode: "auto" }), "auto");
  assert.equal(resolveThinkingMode({ mode: "auto", enabled: true }), "auto");
});

test("resolveThinkingMode: unset config delegates", () => {
  assert.equal(resolveThinkingMode(undefined), "auto");
  assert.equal(resolveThinkingMode({}), "auto");
  assert.equal(
    resolveThinkingMode({ enabled: true, effort: "high" }),
    "effort",
  );
});
