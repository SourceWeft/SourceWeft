import assert from "node:assert/strict";
import { test } from "vitest";
import {
  evaluatePptxComposerBenchmarkSuite,
  evaluatePptxComposerFixture,
  evaluatePptxComposerRenderedFixture,
  getPptxComposerEvalFixture,
  listPptxComposerAdversarialFixtureNames,
  listPptxComposerEvalFixtureNames,
  listPptxComposerHappyPathFixtureNames,
  pptxComposerEvalThresholds,
} from "./index";
import { validatePresentationSourceV1 } from "../domain/validation";

const requiredBenchmarkNames = [
  "education-intro",
  "market-analysis",
  "technical-solution",
  "investor-pitch",
  "data-report",
  "one-slide-deck",
  "thirty-slide-deck",
  "table-heavy-deck",
  "multilingual-deck",
  "conflicting-style-constraints",
] as const;

test("eval exposes deterministic named benchmark fixtures", () => {
  const names = listPptxComposerEvalFixtureNames();

  assert.ok(names.length >= 10);
  assert.equal(new Set(names).size, names.length);
  for (const name of requiredBenchmarkNames) {
    assert.ok(names.includes(name));
  }
});

test("eval scores basic-product-overview with passing pre-render metrics", () => {
  const result = evaluatePptxComposerFixture("basic-product-overview");

  assert.equal(result.valid, true);
  if (!result.valid) {
    assert.fail("basic-product-overview should be schema-valid");
  }
  assert.deepEqual(result.validationIssues, []);
  assert.equal(result.metrics.fixtureName, "basic-product-overview");
  assert.equal(result.metrics.schemaVersion, "pptx-composer.v1");
  assert.equal(result.metrics.slideCount, 4);
  assert.equal(result.passed, true);
  assert.equal(
    result.metrics.requiredSlotFillRate >= pptxComposerEvalThresholds.requiredSlotFillRate,
    true,
  );
  assert.equal(
    result.metrics.layoutDiversityScore >= pptxComposerEvalThresholds.layoutDiversityScore,
    true,
  );
  assert.equal(result.metrics.emptySlideRiskCount, 0);
  assert.equal(result.metrics.editabilityFailureCount, 0);
});

test("eval flags repetitive-slides fixture below diversity threshold", () => {
  const result = evaluatePptxComposerFixture("repetitive-slides");

  assert.equal(result.valid, true);
  if (!result.valid) {
    assert.fail("repetitive-slides should be schema-valid");
  }
  assert.equal(result.metrics.fixtureName, "repetitive-slides");
  assert.equal(result.metrics.slideCount, 5);
  assert.equal(
    result.metrics.layoutDiversityScore < pptxComposerEvalThresholds.layoutDiversityScore,
    true,
  );
  assert.equal(result.thresholdResults.layoutDiversityScore, false);
  assert.equal(result.passed, false);
});

test("eval loader exposes named fixtures deterministically", () => {
  const fixture = getPptxComposerEvalFixture("basic-product-overview");
  const parsed = validatePresentationSourceV1(fixture.source);

  assert.equal(fixture.name, "basic-product-overview");
  assert.equal(fixture.expectedOutcome, "pass");
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.schemaVersion, "pptx-composer.v1");
  }
});

test("happy-path benchmark fixtures render to valid editable PPTX", async () => {
  const happyPathNames = listPptxComposerHappyPathFixtureNames();
  const results = await Promise.all(happyPathNames.map(evaluatePptxComposerRenderedFixture));

  assert.ok(happyPathNames.length >= 10);
  for (const result of results) {
    assert.equal(result.valid, true, result.fixtureName);
    if (!result.valid) {
      assert.fail("happy-path fixture should be schema-valid");
    }
    assert.equal(result.expectedOutcome, "pass", result.fixtureName);
    assert.equal(result.outcome, "passed", result.fixtureName);
    assert.equal(result.rendered, true, result.fixtureName);
    assert.equal(result.passed, true, result.fixtureName);
    assert.equal(result.renderQaReport.status, "passed", result.fixtureName);
    assert.equal(result.metrics.emptySlideRiskCount, 0, result.fixtureName);
    assert.equal(result.metrics.renderEmptySlideCount, 0, result.fixtureName);
    assert.equal(result.metrics.editabilityFailureCount, 0, result.fixtureName);
    assert.equal(result.metrics.renderQaErrorCount, 0, result.fixtureName);
    assert.ok(result.metrics.renderDurationMs > 0, result.fixtureName);
  }
});

test("adversarial benchmark fixtures fail or repair with typed diagnostics", async () => {
  const adversarialNames = listPptxComposerAdversarialFixtureNames();
  const results = await Promise.all(adversarialNames.map(evaluatePptxComposerRenderedFixture));

  assert.deepEqual(adversarialNames.sort(), [
    "conflicting-style-constraints",
    "invalid-layoutspec",
    "long-title-overflow",
    "repetitive-slides",
  ]);
  for (const result of results) {
    assert.equal(result.passed, true, result.fixtureName);
    assert.ok(result.outcome === "failed" || result.outcome === "repaired", result.fixtureName);
    assert.ok(result.diagnostics.length > 0 || result.outcome === "repaired", result.fixtureName);
  }

  const longTitle = results.find((result) => result.fixtureName === "long-title-overflow");
  assert.equal(longTitle?.outcome, "repaired");
  assert.ok(longTitle?.repairResult?.attempts.some((attempt) => attempt.failureCodes.includes("TITLE_OVERFLOW_RISK")));
  assert.ok((longTitle?.metrics?.repairCount ?? 0) > 0);

  const repetitive = results.find((result) => result.fixtureName === "repetitive-slides");
  assert.equal(repetitive?.outcome, "failed");
  assert.ok(repetitive?.diagnostics.some((diagnostic) => diagnostic.includes("LAYOUT_DIVERSITY_TOO_LOW")));

  const invalid = results.find((result) => result.fixtureName === "invalid-layoutspec");
  assert.equal(invalid?.valid, false);
  assert.ok(invalid?.diagnostics.some((diagnostic) => diagnostic.includes("LAYOUT_SPEC_INVALID")));
});

test("rendered benchmark suite reports deterministic quality metrics", async () => {
  const suite = await evaluatePptxComposerBenchmarkSuite();

  assert.equal(suite.fixtureCount, listPptxComposerEvalFixtureNames().length);
  assert.equal(suite.successRate, 1);
  assert.ok(suite.repairCount > 0);
  assert.equal(suite.emptySlideCount, 0);
  assert.equal(suite.editabilityFailures, 0);
  assert.ok(suite.renderDurationMs > 0);
  assert.ok(suite.results.some((result) => result.fixtureName === "thirty-slide-deck" && result.metrics?.slideCount === 30));
});
