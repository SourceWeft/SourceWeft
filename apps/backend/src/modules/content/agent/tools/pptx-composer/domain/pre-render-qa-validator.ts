import { QaReportSchema } from "./schemas";
import type { AssetPlan, PresentationSourceV1, QaReport } from "./schemas";
import { deriveLayoutId, validateLayoutSequence, validateLayoutSpec } from "./layout-system";
import { resolveVisualSystem } from "./visual-system";
import { validatePresentationSourceV1 } from "./validation";

export const PRE_RENDER_QA_MAX_ISSUES = 200;

export const preRenderQaContentIssueCodes = [
  "REQUIRED_SLOT_EMPTY",
  "ASSET_REF_MISSING",
  "PLACEHOLDER_TEXT_PRESENT",
  "CONTENT_TOO_DENSE",
  "GENERIC_TITLE_RATIO_HIGH",
  "LAYOUT_DIVERSITY_TOO_LOW",
  "QA_ISSUES_TRUNCATED",
] as const;

export type PreRenderQaContentIssueCode = (typeof preRenderQaContentIssueCodes)[number];

export type PreRenderQaValidationOptions = {
  readonly failFast?: boolean;
};

export type PreRenderQaInput = {
  readonly source: PresentationSourceV1;
  readonly options?: PreRenderQaValidationOptions;
};

export type PreRenderQaUnknownInput = {
  readonly source: unknown;
  readonly options?: PreRenderQaValidationOptions;
};

type QaIssue = QaReport["issues"][number];
type QaSeverity = QaIssue["severity"];

type MutableQaIssue = {
  code: string;
  severity: QaSeverity;
  message: string;
  slideId?: string;
  path: Array<string | number>;
};

const AGGREGATE_BODY_SLOTS = new Set(["body", "proof", "proof-chips", "checklist", "insight", "quote", "next-step"]);
const ASSET_LIKE_SLOT_PARTS = ["asset", "image", "photo", "visual", "chart", "table", "diagram", "icon"];
const PLACEHOLDER_PATTERN = /^(tbd|todo|placeholder|lorem ipsum|untitled|title|subtitle|headline|copy here|insert .+)$/i;
const GENERIC_TITLE_PATTERN = /^(overview|introduction|summary|agenda|section|content|slide|untitled)(\s+\d+)?$/i;
const MAX_BODY_ITEMS_BY_DENSITY: Record<PresentationSourceV1["designSystem"]["density"], number> = {
  airy: 4,
  balanced: 6,
  dense: 8,
};
const MAX_BODY_CHARS_BY_DENSITY: Record<PresentationSourceV1["designSystem"]["density"], number> = {
  airy: 420,
  balanced: 680,
  dense: 920,
};
const MIN_LAYOUT_DIVERSITY_RATIO = 0.45;
const MAX_DOMINANT_LAYOUT_RATIO = 0.65;
const MAX_GENERIC_TITLE_RATIO = 0.5;

export function validatePreRenderQa(input: PreRenderQaInput): QaReport {
  return validateParsedSource(input.source, input.options);
}

export function validatePreRenderQaInput(input: PreRenderQaUnknownInput): QaReport {
  const parsed = validatePresentationSourceV1(input.source);
  if (!parsed.success) {
    return buildReport(parsed.issues.flatMap((issue) => expandSchemaIssue(issue)), input.options);
  }

  return validateParsedSource(parsed.data, input.options);
}

function expandSchemaIssue(issue: { code: string; path: Array<string | number>; message: string }): MutableQaIssue[] {
  const issues: MutableQaIssue[] = [{
    code: issue.code,
    severity: "error",
    message: withRepairHint(issue.message, issue.code),
    path: issue.path,
  }];
  const last = issue.path.at(-1);
  if (issue.path.includes("regions") && (last === "x" || last === "y" || last === "width" || last === "height") && issue.code !== "LAYOUT_REGION_OUT_OF_BOUNDS") {
    issues.push({
      code: "LAYOUT_REGION_OUT_OF_BOUNDS",
      severity: "error",
      message: withRepairHint(issue.message, "LAYOUT_REGION_OUT_OF_BOUNDS"),
      path: issue.path,
    });
  }
  return issues;
}

function validateParsedSource(source: PresentationSourceV1, options: PreRenderQaValidationOptions = {}): QaReport {
  const collector = createIssueCollector(options);

  collectStyleIssues(source, collector);
  if (collector.shouldStop()) return buildReport(collector.issues, options);

  collectLayoutIssues(source, collector);
  if (collector.shouldStop()) return buildReport(collector.issues, options);

  collectContentIssues(source, collector);
  if (collector.shouldStop()) return buildReport(collector.issues, options);

  collectDiversityIssues(source, collector);

  return buildReport(collector.issues, options);
}

function collectStyleIssues(source: PresentationSourceV1, collector: IssueCollector): void {
  const result = resolveVisualSystem({
    brandTokens: source.designSystem,
    presetId: "modern-business",
  });

  for (const issue of result.issues) {
    collector.add({
      code: issue.code,
      severity: issue.severity,
      message: withRepairHint(issue.message, issue.code),
      path: ["designSystem", ...issue.path],
    });
  }
}

function collectLayoutIssues(source: PresentationSourceV1, collector: IssueCollector): void {
  source.slides.forEach((slide, slideIndex) => {
    const result = validateLayoutSpec(slide.layoutSpec, { slideRole: slide.role });
    for (const issue of result.issues) {
      collector.add({
        code: issue.code,
        severity: issue.severity,
        message: withRepairHint(issue.message, issue.code),
        slideId: slide.id,
        path: ["slides", slideIndex, "layoutSpec", ...issue.path],
      });
    }
  });

  const sequence = validateLayoutSequence(source.slides.map((slide) => ({
    slideId: slide.id,
    layoutSpec: slide.layoutSpec,
  })));

  for (const issue of sequence.issues) {
    collector.add({
      code: issue.code,
      severity: issue.severity,
      message: withRepairHint(issue.message, issue.code),
      slideId: issue.slideId,
      path: ["slides", ...issue.path],
    });
  }
}

function collectContentIssues(source: PresentationSourceV1, collector: IssueCollector): void {
  const assetIds = new Set(source.assetPlan.items.map((asset) => asset.id));

  source.slides.forEach((slide, slideIndex) => {
    if (isPlaceholderText(slide.title)) {
      collector.add(contentIssue("PLACEHOLDER_TEXT_PRESENT", "warning", "Slide title contains placeholder text.", slide.id, ["slides", slideIndex, "title"]));
    }
    if (slide.headline && isPlaceholderText(slide.headline)) {
      collector.add(contentIssue("PLACEHOLDER_TEXT_PRESENT", "warning", "Slide headline contains placeholder text.", slide.id, ["slides", slideIndex, "headline"]));
    }
    slide.body.forEach((bodyItem, bodyIndex) => {
      if (isPlaceholderText(bodyItem)) {
        collector.add(contentIssue("PLACEHOLDER_TEXT_PRESENT", "warning", "Slide body contains placeholder text.", slide.id, ["slides", slideIndex, "body", bodyIndex]));
      }
    });

    for (const slot of slide.layoutSpec.requiredSlots) {
      if (!slotHasContent(slot, slide, source.assetPlan)) {
        collector.add(contentIssue("REQUIRED_SLOT_EMPTY", "error", `Required slot ${slot} has no source content.`, slide.id, ["slides", slideIndex, "layoutSpec", "requiredSlots", slot]));
      }
    }

    slide.assetRefs.forEach((assetRef, assetRefIndex) => {
      if (!assetIds.has(assetRef)) {
        collector.add(contentIssue("ASSET_REF_MISSING", "error", `Asset reference ${assetRef} is not declared in assetPlan.`, slide.id, ["slides", slideIndex, "assetRefs", assetRefIndex]));
      }
    });

    const bodyCharacters = slide.body.reduce((sum, entry) => sum + entry.length, 0);
    const maxItems = MAX_BODY_ITEMS_BY_DENSITY[source.designSystem.density];
    const maxCharacters = MAX_BODY_CHARS_BY_DENSITY[source.designSystem.density];
    if (slide.body.length > maxItems || bodyCharacters > maxCharacters) {
      collector.add(contentIssue("CONTENT_TOO_DENSE", "warning", "Slide body is too dense for the selected deck density.", slide.id, ["slides", slideIndex, "body"]));
    }
  });
}

function collectDiversityIssues(source: PresentationSourceV1, collector: IssueCollector): void {
  if (source.slides.length < 3) {
    return;
  }

  const layoutIds = source.slides.map((slide) => deriveLayoutId(slide.layoutSpec));
  const uniqueLayoutCount = new Set(layoutIds).size;
  const layoutDiversityRatio = uniqueLayoutCount / layoutIds.length;
  const dominantLayoutRatio = maxFrequencyRatio(layoutIds);

  if (layoutDiversityRatio < MIN_LAYOUT_DIVERSITY_RATIO || dominantLayoutRatio > MAX_DOMINANT_LAYOUT_RATIO) {
    collector.add(contentIssue("LAYOUT_DIVERSITY_TOO_LOW", "error", "Deck uses too few distinct layout structures.", undefined, ["slides"]));
  }

  const genericTitleRatio = source.slides.filter((slide) => GENERIC_TITLE_PATTERN.test(slide.title.trim())).length / source.slides.length;
  if (genericTitleRatio > MAX_GENERIC_TITLE_RATIO) {
    collector.add(contentIssue("GENERIC_TITLE_RATIO_HIGH", "warning", "Too many slide titles are generic.", undefined, ["slides", "title"]));
  }
}

function buildReport(issues: MutableQaIssue[], options: PreRenderQaValidationOptions = {}): QaReport {
  const hasBlockingIssue = issues.some((issue) => issue.severity === "error");
  const normalized = normalizeIssueList(issues, options.failFast === true);
  return QaReportSchema.parse({
    status: hasBlockingIssue ? "failed" : "passed",
    issues: normalized,
    checkedAtIso: new Date().toISOString(),
  });
}

function normalizeIssueList(issues: MutableQaIssue[], failFast: boolean): QaIssue[] {
  const selected = failFast ? firstBlockingIssue(issues) : issues;
  const truncated = selected.length > PRE_RENDER_QA_MAX_ISSUES;
  const capped = truncated
    ? selected.slice(0, PRE_RENDER_QA_MAX_ISSUES - 1)
    : selected;
  const normalized = capped.map((issue) => toIssue(issue));

  if (truncated) {
    normalized.push(toIssue({
      code: "QA_ISSUES_TRUNCATED",
      severity: "warning",
      message: `QA issue output exceeded ${PRE_RENDER_QA_MAX_ISSUES}; additional issues were truncated.`,
      path: ["qaReport", "issues"],
    }));
  }

  return normalized;
}

function firstBlockingIssue(issues: MutableQaIssue[]): MutableQaIssue[] {
  const firstError = issues.find((issue) => issue.severity === "error");
  return firstError ? [firstError] : issues.slice(0, 1);
}

type IssueCollector = ReturnType<typeof createIssueCollector>;

function createIssueCollector(options: PreRenderQaValidationOptions) {
  const issues: MutableQaIssue[] = [];
  return {
    issues,
    add(issue: MutableQaIssue) {
      if (options.failFast === true && issues.some((entry) => entry.severity === "error")) {
        return;
      }
      issues.push(issue);
    },
    shouldStop() {
      return options.failFast === true && issues.some((issue) => issue.severity === "error");
    },
  };
}

function contentIssue(code: PreRenderQaContentIssueCode, severity: QaSeverity, message: string, slideId: string | undefined, path: Array<string | number>): MutableQaIssue {
  return {
    code,
    severity,
    message: withRepairHint(message, code),
    slideId,
    path,
  };
}

function toIssue(issue: MutableQaIssue): QaIssue {
  return {
    code: clampText(issue.code, 80),
    severity: issue.severity,
    message: clampText(issue.message, 500),
    slideId: issue.slideId ? clampText(issue.slideId, 80) : undefined,
    path: issue.path.filter((part) => typeof part === "string" || typeof part === "number").slice(0, 16),
  };
}

function slotHasContent(slot: string, slide: PresentationSourceV1["slides"][number], assetPlan: AssetPlan): boolean {
  const normalized = slot.toLowerCase();
  if (normalized === "title") return isNonPlaceholderText(slide.title);
  if (normalized === "headline" || normalized === "subtitle") return isNonPlaceholderText(slide.headline);
  const requiredBodyIndex = bodyIndexForSlot(normalized);
  if (requiredBodyIndex !== undefined) return isNonPlaceholderText(slide.body[requiredBodyIndex]);
  if (AGGREGATE_BODY_SLOTS.has(normalized)) return slide.body.some(isNonPlaceholderText) || isNonPlaceholderText(slide.visualIntent);
  if (ASSET_LIKE_SLOT_PARTS.some((part) => normalized.includes(part))) return hasDeclaredAssetForSlot(normalized, slide.assetRefs, assetPlan);
  return slide.body.some(isNonPlaceholderText) || isNonPlaceholderText(slide.headline) || isNonPlaceholderText(slide.visualIntent);
}

function bodyIndexForSlot(slot: string): number | undefined {
  const letterIndex = /^column-([abc])$/.exec(slot)?.[1];
  if (letterIndex === "a") return 0;
  if (letterIndex === "b") return 1;
  if (letterIndex === "c") return 2;
  const optionIndex = /^option-([ab])$/.exec(slot)?.[1];
  if (optionIndex === "a") return 0;
  if (optionIndex === "b") return 1;
  const numberedIndex = /^(card|step)-(\d+)$/.exec(slot)?.[2];
  if (numberedIndex) return Number.parseInt(numberedIndex, 10) - 1;
  if (slot === "attribution") return 1;
  return undefined;
}

function hasDeclaredAssetForSlot(slot: string, assetRefs: string[], assetPlan: AssetPlan): boolean {
  const requiredKind = assetKindForSlot(slot);
  const declaredAssets = assetPlan.items.filter((asset) => assetRefs.includes(asset.id));
  if (!requiredKind) return declaredAssets.length > 0;
  return declaredAssets.some((asset) => asset.kind === requiredKind);
}

function assetKindForSlot(slot: string): AssetPlan["items"][number]["kind"] | undefined {
  if (slot.includes("chart")) return "chart";
  if (slot.includes("table")) return "table";
  if (slot.includes("diagram")) return "diagram";
  if (slot.includes("icon")) return "icon";
  if (slot.includes("image") || slot.includes("photo")) return "image";
  return undefined;
}

function isNonPlaceholderText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0 && !isPlaceholderText(value);
}

function isPlaceholderText(value: string): boolean {
  return PLACEHOLDER_PATTERN.test(value.trim());
}

function maxFrequencyRatio(values: string[]): number {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Math.max(...counts.values()) / values.length;
}

function withRepairHint(message: string, code: string): string {
  if (message.includes("Repair hint:")) {
    return message;
  }
  return `${message} Repair hint: ${repairHintFor(code)}`;
}

function repairHintFor(code: string): string {
  if (code.startsWith("LAYOUT_")) return "choose a compatible layout family, add required regions, or vary repeated layouts.";
  if (code.startsWith("STYLE_TOKEN_")) return "adjust design tokens to accessible hex colors, density, palette size, and readable typography.";
  if (code === "REQUIRED_SLOT_EMPTY") return "fill every required layout slot with title, headline, body, or declared asset content.";
  if (code === "ASSET_REF_MISSING") return "declare the referenced asset in assetPlan or remove the slide assetRef.";
  if (code === "PLACEHOLDER_TEXT_PRESENT") return "replace placeholder copy with final slide-specific wording.";
  if (code === "CONTENT_TOO_DENSE") return "split dense body copy across slides or shorten bullets.";
  if (code === "GENERIC_TITLE_RATIO_HIGH") return "rewrite generic titles as specific narrative claims.";
  if (code === "LAYOUT_DIVERSITY_TOO_LOW") return "use at least three distinct layout structures and avoid one dominant family.";
  return "revise the source before rendering.";
}

function clampText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength);
}
