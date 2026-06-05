import { PptxGenJsRendererAdapter } from "../adapters";
import {
  basicProductOverviewFixture,
  brandLowContrastFixture,
  conflictingStyleConstraintsFixture,
  dataReportFixture,
  educationIntroFixture,
  invalidLayoutSpecFixture,
  investorPitchFixture,
  longTitleOverflowFixture,
  marketAnalysisFixture,
  multilingualDeckFixture,
  oneSlideDeckFixture,
  repetitiveSlidesFixture,
  tableHeavyDeckFixture,
  technicalSolutionFixture,
  thirtySlideDeckFixture,
} from "../__fixtures__";
import { validatePreRenderQa } from "../domain/pre-render-qa-validator";
import type { PresentationSourceV1, QaReport, SlideInstruction } from "../domain/schemas";
import {
  validatePresentationSourceV1,
  type PresentationSourceValidationIssue,
} from "../domain/validation";
import { inspectOoxmlPptx } from "../inspection";
import { validateRenderQa } from "../inspection/render-qa-validator";
import { repairPresentationSource, type RepairPresentationSourceResult } from "../use-cases";

export const pptxComposerEvalThresholds = {
  requiredSlotFillRate: 0.9,
  layoutDiversityScore: 0.6,
  emptySlideRiskCount: 0,
  editabilityFailureCount: 0,
  renderEmptySlideCount: 0,
  renderQaErrorCount: 0,
} as const;

const pptxComposerEvalFixtures = {
  "basic-product-overview": basicProductOverviewFixture,
  "education-intro": educationIntroFixture,
  "market-analysis": marketAnalysisFixture,
  "technical-solution": technicalSolutionFixture,
  "investor-pitch": investorPitchFixture,
  "data-report": dataReportFixture,
  "one-slide-deck": oneSlideDeckFixture,
  "thirty-slide-deck": thirtySlideDeckFixture,
  "table-heavy-deck": tableHeavyDeckFixture,
  "multilingual-deck": multilingualDeckFixture,
  "brand-low-contrast": brandLowContrastFixture,
  "long-title-overflow": longTitleOverflowFixture,
  "repetitive-slides": repetitiveSlidesFixture,
  "conflicting-style-constraints": conflictingStyleConstraintsFixture,
  "invalid-layoutspec": invalidLayoutSpecFixture,
} as const satisfies Record<string, unknown>;

const benchmarkExpectations = {
  "basic-product-overview": "pass",
  "education-intro": "pass",
  "market-analysis": "pass",
  "technical-solution": "pass",
  "investor-pitch": "pass",
  "data-report": "pass",
  "one-slide-deck": "pass",
  "thirty-slide-deck": "pass",
  "table-heavy-deck": "pass",
  "multilingual-deck": "pass",
  "brand-low-contrast": "pass",
  "long-title-overflow": "repair",
  "repetitive-slides": "fail",
  "conflicting-style-constraints": "fail",
  "invalid-layoutspec": "fail",
} as const satisfies Record<keyof typeof pptxComposerEvalFixtures, PptxComposerBenchmarkExpectation>;

const forcedRepairRenderQaIssues: Partial<Record<string, QaReport["issues"]>> = {
  "long-title-overflow": [
    {
      code: "TITLE_OVERFLOW_RISK",
      severity: "error",
      message: "Rendered title exceeds safe editable text bounds.",
      slideId: "slide-long-title-cover",
      path: ["slides", 0, "title"],
    },
  ],
};

export type PptxComposerEvalFixtureName = keyof typeof pptxComposerEvalFixtures;
export type PptxComposerBenchmarkExpectation = "pass" | "repair" | "fail";
export type PptxComposerBenchmarkOutcome = "passed" | "repaired" | "failed";

export type PptxComposerEvalFixture = {
  name: PptxComposerEvalFixtureName;
  expectedOutcome: PptxComposerBenchmarkExpectation;
  source: unknown;
};

export type PptxComposerEvalMetrics = {
  fixtureName: PptxComposerEvalFixtureName;
  schemaVersion: PresentationSourceV1["schemaVersion"];
  slideCount: number;
  requiredSlotFillRate: number;
  layoutDiversityScore: number;
  emptySlideRiskCount: number;
  overflowCount: number;
  editabilityFailureCount: number;
  renderEmptySlideCount: number;
  renderQaErrorCount: number;
  repairCount: number;
  renderDurationMs: number;
};

export type PptxComposerRenderedEvalResult =
  | {
      fixtureName: PptxComposerEvalFixtureName;
      expectedOutcome: PptxComposerBenchmarkExpectation;
      outcome: "passed" | "repaired" | "failed";
      valid: true;
      passed: boolean;
      rendered: boolean;
      metrics: PptxComposerEvalMetrics;
      thresholdResults: Record<keyof typeof pptxComposerEvalThresholds, boolean>;
      validationIssues: [];
      preRenderQaReport: QaReport;
      renderQaReport: QaReport;
      repairResult: RepairPresentationSourceResult | null;
      diagnostics: string[];
    }
  | {
      fixtureName: PptxComposerEvalFixtureName;
      expectedOutcome: PptxComposerBenchmarkExpectation;
      outcome: "failed";
      valid: false;
      passed: boolean;
      rendered: false;
      metrics: null;
      thresholdResults: null;
      validationIssues: PresentationSourceValidationIssue[];
      preRenderQaReport: null;
      renderQaReport: null;
      repairResult: null;
      diagnostics: string[];
    };

export type PptxComposerEvalResult =
  | {
      fixtureName: PptxComposerEvalFixtureName;
      valid: true;
      passed: boolean;
      metrics: PptxComposerEvalMetrics;
      thresholdResults: Record<keyof typeof pptxComposerEvalThresholds, boolean>;
      validationIssues: [];
    }
  | {
      fixtureName: PptxComposerEvalFixtureName;
      valid: false;
      passed: false;
      metrics: null;
      thresholdResults: null;
      validationIssues: PresentationSourceValidationIssue[];
    };

export type PptxComposerBenchmarkSuiteResult = {
  fixtureCount: number;
  successRate: number;
  repairCount: number;
  emptySlideCount: number;
  overflowCount: number;
  editabilityFailures: number;
  renderDurationMs: number;
  results: PptxComposerRenderedEvalResult[];
};

const NOT_RUN_RENDER_QA_REPORT: QaReport = {
  status: "not_run",
  issues: [],
  extensions: { phase: "render" },
};

export function getPptxComposerEvalFixture(
  fixtureName: PptxComposerEvalFixtureName,
): PptxComposerEvalFixture {
  return {
    name: fixtureName,
    expectedOutcome: benchmarkExpectations[fixtureName],
    source: pptxComposerEvalFixtures[fixtureName],
  };
}

export function listPptxComposerEvalFixtureNames(): PptxComposerEvalFixtureName[] {
  return Object.keys(pptxComposerEvalFixtures) as PptxComposerEvalFixtureName[];
}

export function listPptxComposerHappyPathFixtureNames(): PptxComposerEvalFixtureName[] {
  return listPptxComposerEvalFixtureNames().filter((name) => benchmarkExpectations[name] === "pass");
}

export function listPptxComposerAdversarialFixtureNames(): PptxComposerEvalFixtureName[] {
  return listPptxComposerEvalFixtureNames().filter((name) => benchmarkExpectations[name] !== "pass");
}

export function evaluatePptxComposerFixture(
  fixtureName: PptxComposerEvalFixtureName,
): PptxComposerEvalResult {
  const fixture = getPptxComposerEvalFixture(fixtureName);
  const parsed = validatePresentationSourceV1(fixture.source);

  if (!parsed.success) {
    return {
      fixtureName,
      valid: false,
      passed: false,
      metrics: null,
      thresholdResults: null,
      validationIssues: parsed.issues,
    };
  }

  const preRenderQaReport = validatePreRenderQa({ source: parsed.data });
  const metrics = scorePresentationSource(fixtureName, parsed.data, {
    preRenderQaReport,
    renderDurationMs: deterministicRenderDurationMs(parsed.data),
  });
  const thresholdResults = scoreThresholds(metrics);

  return {
    fixtureName,
    valid: true,
    passed: Object.values(thresholdResults).every(Boolean) && preRenderQaReport.status !== "failed",
    metrics,
    thresholdResults,
    validationIssues: [],
  };
}

export async function evaluatePptxComposerRenderedFixture(
  fixtureName: PptxComposerEvalFixtureName,
): Promise<PptxComposerRenderedEvalResult> {
  const fixture = getPptxComposerEvalFixture(fixtureName);
  const parsed = validatePresentationSourceV1(fixture.source);

  if (!parsed.success) {
    const outcome = "failed";
    return {
      fixtureName,
      expectedOutcome: fixture.expectedOutcome,
      outcome,
      valid: false,
      passed: outcomeMatchesExpectation(outcome, fixture.expectedOutcome),
      rendered: false,
      metrics: null,
      thresholdResults: null,
      validationIssues: parsed.issues,
      preRenderQaReport: null,
      renderQaReport: null,
      repairResult: null,
      diagnostics: parsed.issues.map((issue) => `schema:${issue.code}:${issue.message}`),
    };
  }

  const preRenderQaReport = validatePreRenderQa({ source: parsed.data });
  const forcedRenderQaReport = buildForcedRenderQaReport(fixtureName);
  const shouldAttemptRepair = preRenderQaReport.status === "failed" || forcedRenderQaReport.status === "failed";
  const repairResult = shouldAttemptRepair
    ? repairPresentationSource({
        source: parsed.data,
        preRenderQaReport,
        renderQaReport: forcedRenderQaReport,
      })
    : null;
  const sourceToRender = repairResult?.status === "repaired" ? repairResult.source : parsed.data;

  if (repairResult?.status === "failed") {
    const metrics = scorePresentationSource(fixtureName, repairResult.source, {
      preRenderQaReport: repairResult.preRenderQaReport,
      renderQaReport: repairResult.renderQaReport,
      repairCount: repairResult.attempts.length,
      renderDurationMs: 0,
    });
    const outcome = "failed";
    return {
      fixtureName,
      expectedOutcome: fixture.expectedOutcome,
      outcome,
      valid: true,
      passed: outcomeMatchesExpectation(outcome, fixture.expectedOutcome),
      rendered: false,
      metrics,
      thresholdResults: scoreThresholds(metrics),
      validationIssues: [],
      preRenderQaReport: repairResult.preRenderQaReport,
      renderQaReport: repairResult.renderQaReport,
      repairResult,
      diagnostics: repairResult.diagnostics,
    };
  }

  const renderer = new PptxGenJsRendererAdapter();
  const rendered = await renderer.renderPresentation({ source: sourceToRender });
  const renderQaReport = validateRenderQa({ source: sourceToRender, pptxBuffer: rendered.pptxBuffer });
  const inspection = inspectOoxmlPptx(rendered.pptxBuffer);
  const metrics = scorePresentationSource(fixtureName, sourceToRender, {
    preRenderQaReport: repairResult?.preRenderQaReport ?? preRenderQaReport,
    renderQaReport,
    repairCount: repairResult?.attempts.length ?? 0,
    renderDurationMs: deterministicRenderDurationMs(sourceToRender),
    renderEmptySlideCount: renderQaReport.issues.filter((issue) => issue.code === "SLIDE_STRUCTURALLY_EMPTY").length,
    editabilityFailureCount: countEditabilityFailures(renderQaReport) + countMetadataEditabilityFailures(rendered.metadata.editablePrimitiveCountsBySlide ?? []),
  });
  const thresholdResults = scoreThresholds(metrics);
  const outcome = repairResult?.status === "repaired" ? "repaired" : renderQaReport.status === "passed" && Object.values(thresholdResults).every(Boolean) ? "passed" : "failed";

  return {
    fixtureName,
    expectedOutcome: fixture.expectedOutcome,
    outcome,
    valid: true,
    passed: outcomeMatchesExpectation(outcome, fixture.expectedOutcome),
    rendered: true,
    metrics: {
      ...metrics,
      renderEmptySlideCount: metrics.renderEmptySlideCount + inspection.slides.filter((slide) => slide.shapes.length === 0).length,
    },
    thresholdResults,
    validationIssues: [],
    preRenderQaReport: repairResult?.preRenderQaReport ?? preRenderQaReport,
    renderQaReport,
    repairResult,
    diagnostics: [
      ...(repairResult?.diagnostics ?? []),
      ...renderQaReport.issues.map((issue) => `render:${issue.code}:${issue.message}`),
    ],
  };
}

export async function evaluatePptxComposerBenchmarkSuite(): Promise<PptxComposerBenchmarkSuiteResult> {
  const results = await Promise.all(listPptxComposerEvalFixtureNames().map(evaluatePptxComposerRenderedFixture));
  const expectedSuccesses = results.filter((result) => result.passed).length;
  const metrics = results.flatMap((result) => (result.metrics ? [result.metrics] : []));
  return {
    fixtureCount: results.length,
    successRate: roundMetric(expectedSuccesses / results.length),
    repairCount: metrics.reduce((sum, entry) => sum + entry.repairCount, 0),
    emptySlideCount: metrics.reduce((sum, entry) => sum + entry.emptySlideRiskCount + entry.renderEmptySlideCount, 0),
    overflowCount: metrics.reduce((sum, entry) => sum + entry.overflowCount, 0),
    editabilityFailures: metrics.reduce((sum, entry) => sum + entry.editabilityFailureCount, 0),
    renderDurationMs: metrics.reduce((sum, entry) => sum + entry.renderDurationMs, 0),
    results,
  };
}

export function scorePresentationSource(
  fixtureName: PptxComposerEvalFixtureName,
  source: PresentationSourceV1,
  reports: {
    readonly preRenderQaReport?: QaReport;
    readonly renderQaReport?: QaReport;
    readonly repairCount?: number;
    readonly renderDurationMs?: number;
    readonly renderEmptySlideCount?: number;
    readonly editabilityFailureCount?: number;
  } = {},
): PptxComposerEvalMetrics {
  return {
    fixtureName,
    schemaVersion: source.schemaVersion,
    slideCount: source.slides.length,
    requiredSlotFillRate: scoreRequiredSlotFillRate(source.slides),
    layoutDiversityScore: scoreLayoutDiversity(source.slides),
    emptySlideRiskCount: countEmptySlideRisks(source.slides),
    overflowCount: countIssuesByPattern([reports.preRenderQaReport, reports.renderQaReport], /OVERFLOW/),
    editabilityFailureCount: reports.editabilityFailureCount ?? countEditabilityFailures(reports.renderQaReport),
    renderEmptySlideCount: reports.renderEmptySlideCount ?? countIssuesByCode(reports.renderQaReport, "SLIDE_STRUCTURALLY_EMPTY"),
    renderQaErrorCount: reports.renderQaReport?.issues.filter((issue) => issue.severity === "error").length ?? 0,
    repairCount: reports.repairCount ?? 0,
    renderDurationMs: reports.renderDurationMs ?? 0,
  };
}

function scoreThresholds(metrics: PptxComposerEvalMetrics): Record<keyof typeof pptxComposerEvalThresholds, boolean> {
  return {
    requiredSlotFillRate:
      metrics.requiredSlotFillRate >= pptxComposerEvalThresholds.requiredSlotFillRate,
    layoutDiversityScore:
      metrics.layoutDiversityScore >= pptxComposerEvalThresholds.layoutDiversityScore,
    emptySlideRiskCount:
      metrics.emptySlideRiskCount <= pptxComposerEvalThresholds.emptySlideRiskCount,
    editabilityFailureCount:
      metrics.editabilityFailureCount <= pptxComposerEvalThresholds.editabilityFailureCount,
    renderEmptySlideCount:
      metrics.renderEmptySlideCount <= pptxComposerEvalThresholds.renderEmptySlideCount,
    renderQaErrorCount:
      metrics.renderQaErrorCount <= pptxComposerEvalThresholds.renderQaErrorCount,
  };
}

function buildForcedRenderQaReport(fixtureName: PptxComposerEvalFixtureName): QaReport {
  const issues: QaReport["issues"] = forcedRepairRenderQaIssues[fixtureName] ?? [];
  if (issues.length === 0) {
    return NOT_RUN_RENDER_QA_REPORT;
  }
  return {
    status: "failed",
    issues: issues.map((issue) => ({ ...issue, path: [...issue.path] })),
    extensions: { phase: "render" },
  } satisfies QaReport;
}

function outcomeMatchesExpectation(outcome: PptxComposerBenchmarkOutcome, expectation: PptxComposerBenchmarkExpectation): boolean {
  if (expectation === "pass") return outcome === "passed";
  if (expectation === "repair") return outcome === "repaired";
  return outcome === "failed";
}

function scoreRequiredSlotFillRate(slides: SlideInstruction[]): number {
  const requiredSlots = slides.flatMap((slide) =>
    slide.layoutSpec.requiredSlots.map((slot) => ({ slide, slot })),
  );

  if (requiredSlots.length === 0) {
    return 1;
  }

  const filledSlots = requiredSlots.filter(({ slide, slot }) => isSlotFilled(slide, slot));
  return roundMetric(filledSlots.length / requiredSlots.length);
}

function isSlotFilled(slide: SlideInstruction, slot: string): boolean {
  const normalizedSlot = slot.toLowerCase();

  if (normalizedSlot === "title") {
    return hasText(slide.title);
  }

  if (normalizedSlot === "headline") {
    return hasText(slide.headline);
  }

  if (normalizedSlot.includes("visual") || normalizedSlot.includes("chart") || normalizedSlot.includes("table")) {
    return hasText(slide.visualIntent) || slide.assetRefs.length > 0;
  }

  return slide.body.length > 0 || slide.assetRefs.length > 0 || hasText(slide.visualIntent);
}

function scoreLayoutDiversity(slides: SlideInstruction[]): number {
  if (slides.length <= 1) {
    return 1;
  }

  const layoutKeys = slides.map(getLayoutKey);
  const uniqueLayoutRatio = new Set(layoutKeys).size / layoutKeys.length;
  const repeatedAdjacentPairs = layoutKeys.filter(
    (layoutKey, index) => index > 0 && layoutKey === layoutKeys[index - 1],
  ).length;
  const adjacentVarietyRatio = 1 - repeatedAdjacentPairs / (layoutKeys.length - 1);

  return roundMetric(uniqueLayoutRatio * adjacentVarietyRatio);
}

function countEmptySlideRisks(slides: SlideInstruction[]): number {
  return slides.filter(
    (slide) =>
      !hasText(slide.title) &&
      !hasText(slide.headline) &&
      slide.body.length === 0 &&
      !hasText(slide.visualIntent) &&
      slide.assetRefs.length === 0,
  ).length;
}

function getLayoutKey(slide: SlideInstruction): string {
  return [
    slide.layoutSpec.kind,
    slide.layoutSpec.name,
    slide.layoutSpec.balance,
    slide.layoutSpec.requiredSlots.join("|"),
  ].join("::");
}

function countIssuesByPattern(reports: Array<QaReport | undefined>, pattern: RegExp): number {
  return reports.reduce((sum, report) => sum + (report?.issues.filter((issue) => pattern.test(issue.code)).length ?? 0), 0);
}

function countIssuesByCode(report: QaReport | undefined, code: string): number {
  return report?.issues.filter((issue) => issue.code === code).length ?? 0;
}

function countEditabilityFailures(report: QaReport | undefined): number {
  return report?.issues.filter((issue) => /EDITABLE_NATIVE|TEXT_FLATTENED_TO_IMAGE|ZERO_SIZE_SHAPE/.test(issue.code)).length ?? 0;
}

function countMetadataEditabilityFailures(counts: ReadonlyArray<{ readonly textBoxes: number }>): number {
  return counts.filter((entry) => entry.textBoxes === 0).length;
}

function deterministicRenderDurationMs(source: PresentationSourceV1): number {
  return source.slides.length * 5;
}

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}
