import { deriveLayoutId } from "../domain/layout-system";
import { validatePreRenderQa } from "../domain/pre-render-qa-validator";
import { PresentationSourceV1Schema } from "../domain/schemas";
import type { LayoutSpec, PresentationSourceV1, QaReport } from "../domain/schemas";

export const REPAIR_LOOP_MAX_ATTEMPTS = 2;

export const repairFailureCodes = [
  "TITLE_OVERFLOW_RISK",
  "LAYOUT_DIVERSITY_TOO_LOW",
  "LAYOUT_ADJACENT_REPEAT_RISK",
  "EDITABLE_NATIVE_REPEATED_EMPTY_GEOMETRY",
  "REQUIRED_SLOT_EMPTY",
  "ASSET_REF_MISSING",
  "PPTX_PACKAGE_INVALID",
  "UNKNOWN_QA_FAILURE",
] as const;

export type RepairFailureCode = (typeof repairFailureCodes)[number];
export type RepairFailureCategory = "recoverable" | "unrecoverable";

export type RepairFailure = {
  readonly code: RepairFailureCode;
  readonly category: RepairFailureCategory;
  readonly sourceIssueCode: string;
  readonly phase: "pre_render" | "render";
  readonly slideId?: string;
  readonly message: string;
};

export type SourceMutationSummary = {
  readonly slideCount: number;
  readonly maxTitleLength: number;
  readonly totalTitleLength: number;
  readonly uniqueLayoutCount: number;
  readonly layoutIds: string[];
};

export type RepairAttemptReport = {
  readonly attempt: number;
  readonly failureCodes: RepairFailureCode[];
  readonly before: SourceMutationSummary;
  readonly after: SourceMutationSummary;
  readonly mutations: string[];
  readonly preRenderQaReport: QaReport;
};

export type RepairPresentationSourceInput = {
  readonly source: PresentationSourceV1;
  readonly preRenderQaReport?: QaReport;
  readonly renderQaReport?: QaReport;
};

export type RepairPresentationSourceResult = {
  readonly status: "passed" | "repaired" | "failed";
  readonly source: PresentationSourceV1;
  readonly maxAttempts: typeof REPAIR_LOOP_MAX_ATTEMPTS;
  readonly attempts: RepairAttemptReport[];
  readonly failureCodes: RepairFailureCode[];
  readonly failures: RepairFailure[];
  readonly before: SourceMutationSummary;
  readonly after: SourceMutationSummary;
  readonly preRenderQaReport: QaReport;
  readonly renderQaReport: QaReport;
  readonly diagnostics: string[];
};

const RECOVERABLE_CODES = new Set<string>([
  "TITLE_OVERFLOW_RISK",
  "LAYOUT_DIVERSITY_TOO_LOW",
  "LAYOUT_ADJACENT_REPEAT_RISK",
  "EDITABLE_NATIVE_REPEATED_EMPTY_GEOMETRY",
]);

const TITLE_MAX_LENGTH = 64;

const NOT_RUN_RENDER_QA_REPORT: QaReport = {
  status: "not_run",
  issues: [],
  extensions: { phase: "render" },
};

export function repairPresentationSource(
  input: RepairPresentationSourceInput,
): RepairPresentationSourceResult {
  const initialSource = PresentationSourceV1Schema.parse(input.source);
  const before = summarizeSource(initialSource);
  const initialPreRenderQaReport = input.preRenderQaReport ?? validatePreRenderQa({ source: initialSource });
  const initialRenderQaReport = input.renderQaReport ?? NOT_RUN_RENDER_QA_REPORT;
  const initialFailures = classifyFailures(initialPreRenderQaReport, initialRenderQaReport);

  if (initialFailures.length === 0) {
    return buildResult({
      status: "passed",
      source: initialSource,
      attempts: [],
      failures: [],
      before,
      preRenderQaReport: initialPreRenderQaReport,
      renderQaReport: initialRenderQaReport,
    });
  }

  let currentSource = initialSource;
  let currentPreRenderQaReport = initialPreRenderQaReport;
  const attempts: RepairAttemptReport[] = [];

  for (let attempt = 1; attempt <= REPAIR_LOOP_MAX_ATTEMPTS; attempt += 1) {
    const failures = classifyFailures(
      currentPreRenderQaReport,
      attempt === 1 ? initialRenderQaReport : NOT_RUN_RENDER_QA_REPORT,
    );
    const recoverableFailures = failures.filter((failure) => failure.category === "recoverable");

    if (recoverableFailures.length === 0) {
      break;
    }

    const attemptBefore = summarizeSource(currentSource);
    const candidate = applyDeterministicRepairs(currentSource, recoverableFailures, attempt);
    const candidatePreRenderQaReport = validatePreRenderQa({ source: candidate });
    const repairedCandidate = {
      ...candidate,
      qaReport: candidatePreRenderQaReport,
    } satisfies PresentationSourceV1;
    const attemptAfter = summarizeSource(repairedCandidate);

    attempts.push({
      attempt,
      failureCodes: uniqueFailureCodes(recoverableFailures),
      before: attemptBefore,
      after: attemptAfter,
      mutations: describeMutations(attemptBefore, attemptAfter),
      preRenderQaReport: candidatePreRenderQaReport,
    });

    currentSource = repairedCandidate;
    currentPreRenderQaReport = candidatePreRenderQaReport;

    if (currentPreRenderQaReport.status === "passed") {
      return buildResult({
        status: "repaired",
        source: currentSource,
        attempts,
        failures: [],
        before,
        preRenderQaReport: currentPreRenderQaReport,
        renderQaReport: NOT_RUN_RENDER_QA_REPORT,
      });
    }
  }

  const failures = classifyFailures(currentPreRenderQaReport, NOT_RUN_RENDER_QA_REPORT);
  return buildResult({
    status: "failed",
    source: currentSource,
    attempts,
    failures,
    before,
    preRenderQaReport: currentPreRenderQaReport,
    renderQaReport: NOT_RUN_RENDER_QA_REPORT,
  });
}

function applyDeterministicRepairs(
  source: PresentationSourceV1,
  failures: RepairFailure[],
  attempt: number,
): PresentationSourceV1 {
  let repaired = cloneSource(source);
  if (failures.some((failure) => failure.code === "TITLE_OVERFLOW_RISK")) {
    repaired = compressOverflowTitles(repaired, failures);
  }
  if (failures.some((failure) => isLayoutRepetitionFailure(failure.code))) {
    repaired = reassignRepeatedLayouts(repaired, attempt);
  }
  return PresentationSourceV1Schema.parse(repaired);
}

function compressOverflowTitles(
  source: PresentationSourceV1,
  failures: RepairFailure[],
): PresentationSourceV1 {
  const targetedSlideIds = new Set(
    failures.map((failure) => failure.slideId).filter((slideId): slideId is string => typeof slideId === "string"),
  );
  const shouldCompressAllLongTitles = targetedSlideIds.size === 0;
  return {
    ...source,
    contentBrief: {
      ...source.contentBrief,
      title: compressText(source.contentBrief.title, TITLE_MAX_LENGTH),
    },
    deckStrategy: {
      ...source.deckStrategy,
      deckTitle: compressText(source.deckStrategy.deckTitle, TITLE_MAX_LENGTH),
    },
    slides: source.slides.map((slide) => {
      if (!shouldCompressAllLongTitles && !targetedSlideIds.has(slide.id)) {
        return slide;
      }
      return {
        ...slide,
        title: compressText(slide.title, TITLE_MAX_LENGTH),
      };
    }),
  };
}

function reassignRepeatedLayouts(source: PresentationSourceV1, attempt: number): PresentationSourceV1 {
  return {
    ...source,
    slides: source.slides.map((slide, index) => {
      if (index % 2 === 0) {
        return slide;
      }
      return {
        ...slide,
        layoutSpec: sectionLayoutSpec(`repair-section-${attempt}`),
      };
    }),
  };
}

function sectionLayoutSpec(name: string): LayoutSpec {
  return {
    kind: "locked",
    name,
    intent: "Repair fallback title layout for repetitive slide sequences.",
    requiredSlots: ["title"],
    regions: [
      { id: `${name}-title`, slot: "title", x: 0.12, y: 0.34, width: 0.76, height: 0.2, zIndex: 1 },
    ],
    balance: "centered",
  };
}

function classifyFailures(preRenderQaReport: QaReport, renderQaReport: QaReport): RepairFailure[] {
  return [
    ...classifyReportFailures(preRenderQaReport, "pre_render"),
    ...classifyReportFailures(renderQaReport, "render"),
  ];
}

function classifyReportFailures(report: QaReport, phase: RepairFailure["phase"]): RepairFailure[] {
  if (report.status !== "failed") {
    return [];
  }
  return report.issues.map((issue) => {
    const code = normalizeFailureCode(issue.code);
    return {
      code,
      category: RECOVERABLE_CODES.has(issue.code) ? "recoverable" : "unrecoverable",
      sourceIssueCode: issue.code,
      phase,
      slideId: issue.slideId,
      message: issue.message,
    } satisfies RepairFailure;
  });
}

function normalizeFailureCode(code: string): RepairFailureCode {
  if (code === "TITLE_OVERFLOW_RISK") return "TITLE_OVERFLOW_RISK";
  if (code === "LAYOUT_DIVERSITY_TOO_LOW") return "LAYOUT_DIVERSITY_TOO_LOW";
  if (code === "LAYOUT_ADJACENT_REPEAT_RISK") return "LAYOUT_ADJACENT_REPEAT_RISK";
  if (code === "EDITABLE_NATIVE_REPEATED_EMPTY_GEOMETRY") return "EDITABLE_NATIVE_REPEATED_EMPTY_GEOMETRY";
  if (code === "REQUIRED_SLOT_EMPTY") return "REQUIRED_SLOT_EMPTY";
  if (code === "ASSET_REF_MISSING") return "ASSET_REF_MISSING";
  if (code === "PPTX_PACKAGE_INVALID") return "PPTX_PACKAGE_INVALID";
  return "UNKNOWN_QA_FAILURE";
}

function summarizeSource(source: PresentationSourceV1): SourceMutationSummary {
  const titleLengths = source.slides.map((slide) => slide.title.length);
  const layoutIds = source.slides.map((slide) => deriveLayoutId(slide.layoutSpec));
  return {
    slideCount: source.slides.length,
    maxTitleLength: titleLengths.length > 0 ? Math.max(...titleLengths) : 0,
    totalTitleLength: titleLengths.reduce((sum, length) => sum + length, 0),
    uniqueLayoutCount: new Set(layoutIds).size,
    layoutIds,
  };
}

function describeMutations(before: SourceMutationSummary, after: SourceMutationSummary): string[] {
  const mutations: string[] = [];
  if (before.slideCount !== after.slideCount) {
    mutations.push(`slide count ${before.slideCount} -> ${after.slideCount}`);
  }
  if (before.maxTitleLength !== after.maxTitleLength || before.totalTitleLength !== after.totalTitleLength) {
    mutations.push(`titles max ${before.maxTitleLength} -> ${after.maxTitleLength}, total ${before.totalTitleLength} -> ${after.totalTitleLength}`);
  }
  if (before.uniqueLayoutCount !== after.uniqueLayoutCount || before.layoutIds.join("|") !== after.layoutIds.join("|")) {
    mutations.push(`layouts unique ${before.uniqueLayoutCount} -> ${after.uniqueLayoutCount}`);
  }
  if (mutations.length === 0) {
    mutations.push("no source mutation applied");
  }
  return mutations;
}

function buildResult(input: {
  readonly status: RepairPresentationSourceResult["status"];
  readonly source: PresentationSourceV1;
  readonly attempts: RepairAttemptReport[];
  readonly failures: RepairFailure[];
  readonly before: SourceMutationSummary;
  readonly preRenderQaReport: QaReport;
  readonly renderQaReport: QaReport;
}): RepairPresentationSourceResult {
  const after = summarizeSource(input.source);
  const failureCodes = uniqueFailureCodes(input.failures);
  return {
    status: input.status,
    source: input.source,
    maxAttempts: REPAIR_LOOP_MAX_ATTEMPTS,
    attempts: input.attempts,
    failureCodes,
    failures: input.failures,
    before: input.before,
    after,
    preRenderQaReport: input.preRenderQaReport,
    renderQaReport: input.renderQaReport,
    diagnostics: input.failures.map((failure) => `${failure.phase}:${failure.code}:${failure.message}`),
  };
}

function uniqueFailureCodes(failures: RepairFailure[]): RepairFailureCode[] {
  return Array.from(new Set(failures.map((failure) => failure.code)));
}

function isLayoutRepetitionFailure(code: RepairFailureCode): boolean {
  return code === "LAYOUT_DIVERSITY_TOO_LOW" || code === "LAYOUT_ADJACENT_REPEAT_RISK" || code === "EDITABLE_NATIVE_REPEATED_EMPTY_GEOMETRY";
}

function compressText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  const boundary = trimmed.lastIndexOf(" ", maxLength - 3);
  const cutPoint = boundary >= 24 ? boundary : maxLength - 3;
  return `${trimmed.slice(0, cutPoint).trim()}...`;
}

function cloneSource(source: PresentationSourceV1): PresentationSourceV1 {
  return PresentationSourceV1Schema.parse(source);
}
