import assert from "node:assert/strict";
import { test } from "vitest";
import { longTitleOverflowFixture, repetitiveSlidesFixture } from "./__fixtures__";
import { validatePreRenderQa } from "./domain/pre-render-qa-validator";
import type { QaReport } from "./domain/schemas";
import { repairPresentationSource, REPAIR_LOOP_MAX_ATTEMPTS } from "./use-cases";

test("repair loop fixes long-title-overflow within max attempts", () => {
  const renderQaReport: QaReport = {
    status: "failed",
    issues: [
      {
        code: "TITLE_OVERFLOW_RISK",
        severity: "error",
        message: "Rendered title exceeds safe editable text bounds.",
        slideId: "slide-long-title-cover",
        path: ["slides", 0, "title"],
      },
    ],
    extensions: { phase: "render" },
  };

  const result = repairPresentationSource({
    source: longTitleOverflowFixture,
    preRenderQaReport: validatePreRenderQa({ source: longTitleOverflowFixture }),
    renderQaReport,
  });

  assert.equal(result.maxAttempts, REPAIR_LOOP_MAX_ATTEMPTS);
  assert.equal(result.status, "repaired");
  assert.ok(result.attempts.length > 0);
  assert.ok(result.attempts.length <= REPAIR_LOOP_MAX_ATTEMPTS);
  assert.equal(result.preRenderQaReport.status, "passed");
  assert.ok(result.after.maxTitleLength < result.before.maxTitleLength);
  assert.ok(result.attempts[0]?.failureCodes.includes("TITLE_OVERFLOW_RISK"));
  assert.ok(result.attempts[0]?.mutations.some((mutation) => mutation.startsWith("titles max")));
  assert.equal(result.source.slides.length, longTitleOverflowFixture.slides.length);
});

test("repair loop stops after max attempts and returns diagnostics", () => {
  const result = repairPresentationSource({ source: repetitiveSlidesFixture });

  assert.equal(result.maxAttempts, 2);
  assert.equal(result.status, "failed");
  assert.equal(result.attempts.length, 2);
  assert.ok(result.failureCodes.includes("LAYOUT_DIVERSITY_TOO_LOW"));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.includes("LAYOUT_DIVERSITY_TOO_LOW")));
  assert.equal(result.preRenderQaReport.status, "failed");
  assert.equal(result.source.slides.length, repetitiveSlidesFixture.slides.length);
  assert.ok(result.attempts.every((attempt) => attempt.before.slideCount === attempt.after.slideCount));
  assert.ok(result.attempts.some((attempt) => attempt.mutations.some((mutation) => mutation.startsWith("layouts unique"))));
});
