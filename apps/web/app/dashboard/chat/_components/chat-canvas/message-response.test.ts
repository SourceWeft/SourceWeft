import assert from "node:assert/strict";
import { test } from "vitest";
import { shouldShowPossibleEvidence } from "./message-evidence";

const citation = {} as never;

test("shouldShowPossibleEvidence requires available unused citations and stable text", () => {
  assert.equal(
    shouldShowPossibleEvidence({
      availableCitations: [citation],
      citations: [],
      hasInlineCitationMarkers: false,
      showLoading: false,
    }),
    true,
  );

  assert.equal(
    shouldShowPossibleEvidence({
      availableCitations: [citation],
      citations: [],
      hasInlineCitationMarkers: false,
      showLoading: true,
    }),
    false,
  );

  assert.equal(
    shouldShowPossibleEvidence({
      availableCitations: [citation],
      citations: [],
      hasInlineCitationMarkers: true,
      showLoading: false,
    }),
    false,
  );

  assert.equal(
    shouldShowPossibleEvidence({
      availableCitations: [citation],
      citations: [citation],
      hasInlineCitationMarkers: false,
      showLoading: false,
    }),
    false,
  );
});
