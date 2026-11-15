import assert from "node:assert/strict";
import test from "node:test";
import { finalizeUsage } from "../src/observation/normalize";
import type { ModelCallDiagnostic } from "../src/observation/types";

test("fractional audio seconds are kept; they are a duration, not a count", () => {
  const diagnostics: ModelCallDiagnostic[] = [];
  const usage = finalizeUsage({ inputAudioSeconds: 17.24 }, diagnostics);
  assert.equal(usage?.inputAudioSeconds, 17.24);
  assert.deepEqual(diagnostics, []);
});

test("negative or non-finite audio seconds are discarded with a diagnostic", () => {
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const diagnostics: ModelCallDiagnostic[] = [];
    const usage = finalizeUsage(
      { inputAudioSeconds: value, inputTokens: 3 },
      diagnostics,
    );
    assert.equal(usage?.inputAudioSeconds, undefined);
    assert.equal(usage?.inputTokens, 3);
    assert.equal(diagnostics[0]?.code, "INVALID_USAGE_FIELD");
  }
});

test("counts still have to be whole numbers", () => {
  const diagnostics: ModelCallDiagnostic[] = [];
  const usage = finalizeUsage(
    { inputCharacters: 12.5, inputTokens: 4 },
    diagnostics,
  );
  assert.equal(usage?.inputCharacters, undefined);
  assert.equal(usage?.inputTokens, 4);
  assert.equal(diagnostics.length, 1);
});
