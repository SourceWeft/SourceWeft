import { QaReportSchema } from "../domain/schemas";
import type { PresentationSourceV1, QaReport } from "../domain/schemas";
import { inspectOoxmlPptx } from "./ooxml-pptx-inspector";

export const RENDER_QA_MAX_ISSUES = 200;
export const RENDER_QA_MIN_BYTE_LENGTH = 1000;

const EMU_PER_INCH = 914400;
const REPEATED_EMPTY_GEOMETRY_PRECISION = 9144;
const MIN_VISIBLE_EMPTY_SHAPE_AREA_INCHES = 0.02;

type QaIssue = QaReport["issues"][number];
type MutableQaIssue = {
  code: string;
  severity: QaIssue["severity"];
  message: string;
  slideId?: string;
  path: Array<string | number>;
};

export type RenderQaValidationOptions = {
  readonly maxIssues?: number;
  readonly minByteLength?: number;
};

export type RenderQaInput = {
  readonly source: PresentationSourceV1;
  readonly pptxBuffer: Buffer;
  readonly options?: RenderQaValidationOptions;
};

export function validateRenderQa(input: RenderQaInput): QaReport {
  const options = input.options ?? {};
  const issues: MutableQaIssue[] = [];
  const minByteLength = options.minByteLength ?? RENDER_QA_MIN_BYTE_LENGTH;
  if (!Buffer.isBuffer(input.pptxBuffer) || input.pptxBuffer.byteLength === 0) {
    issues.push(issue("PPTX_BUFFER_MISSING", "error", "Rendered PPTX buffer is missing or empty.", ["pptxBuffer"]));
    return buildReport(issues, options);
  }
  if (input.pptxBuffer.byteLength < minByteLength) {
    issues.push(issue("PPTX_BUFFER_TOO_SMALL", "error", `Rendered PPTX buffer is below ${minByteLength} bytes.`, ["pptxBuffer", "byteLength"]));
  }

  const inspection = inspectOoxmlPptx(input.pptxBuffer);
  for (const error of inspection.errors) {
    issues.push(issue("PPTX_PACKAGE_INVALID", "error", error, ["pptxBuffer"]));
  }

  for (const requiredPart of ["[Content_Types].xml", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels"]) {
    if (!inspection.entryNames.has(requiredPart)) {
      issues.push(issue("PPTX_REQUIRED_PART_MISSING", "error", `Required PPTX part ${requiredPart} is missing.`, ["pptx", requiredPart]));
    }
  }

  if (inspection.slides.length !== input.source.slides.length) {
    issues.push(issue("SLIDE_COUNT_MISMATCH", "error", `Rendered slide count ${inspection.slides.length} does not match source slide count ${input.source.slides.length}.`, ["slides"]));
  }

  const repeatedEmptyGeometry = new Map<string, Set<number>>();

  inspection.slides.forEach((slide, slideIndex) => {
    const sourceSlide = input.source.slides[slideIndex];
    if (!slide.xml.trim() || !/<p:sld\b/.test(slide.xml) || slide.shapes.length === 0) {
      issues.push(issue("SLIDE_STRUCTURALLY_EMPTY", "error", `Rendered slide ${slide.slideNumber} has empty or non-structural XML.`, ["slides", slideIndex]));
    }
    for (const shape of slide.shapes) {
      if (isNonDecorativeShape(shape.name) && (shape.cx === 0 || shape.cy === 0)) {
        issues.push(issue("ZERO_SIZE_SHAPE", "error", `Rendered slide ${slide.slideNumber} contains zero-size shape ${shape.name || "unnamed"}.`, ["slides", slideIndex, "shapes"], sourceSlide?.id));
      }
      if (isVisibleEmptyShape(shape)) {
        issues.push(issue("EDITABLE_NATIVE_EMPTY_SHAPE", "error", `Rendered slide ${slide.slideNumber} contains visible empty shape ${shape.name || "unnamed"}.`, ["slides", slideIndex, "shapes"], sourceSlide?.id));
        const signature = emptyShapeGeometrySignature(shape);
        if (signature) {
          const slides = repeatedEmptyGeometry.get(signature) ?? new Set<number>();
          slides.add(slide.slideNumber);
          repeatedEmptyGeometry.set(signature, slides);
        }
      }
    }
    for (const target of slide.imageRelationshipTargets) {
      if (!inspection.entryNames.has(target)) {
        issues.push(issue("BROKEN_IMAGE_RELATIONSHIP", "error", `Rendered slide ${slide.slideNumber} references missing image ${target}.`, ["slides", slideIndex, "relationships"], sourceSlide?.id));
      }
    }
    if (sourceSlide) {
      for (const expectedText of expectedTextRunsForSlide(sourceSlide)) {
        if (!slide.text.includes(expectedText)) {
          issues.push(issue("TEXT_RUN_MISSING", "error", `Rendered slide ${slide.slideNumber} is missing expected text: ${expectedText}.`, ["slides", slideIndex, "text"], sourceSlide.id));
        }
      }
      if (slide.hasImageOnlyTextFlatteningRisk && expectedTextRunsForSlide(sourceSlide).length > 0) {
        issues.push(issue("TEXT_FLATTENED_TO_IMAGE", "error", `Rendered slide ${slide.slideNumber} appears to contain text flattened into image primitives instead of editable text boxes.`, ["slides", slideIndex, "editablePrimitiveCounts"], sourceSlide.id));
      }
    }
  });

  for (const slides of repeatedEmptyGeometry.values()) {
    if (slides.size >= 3) {
      issues.push(issue("EDITABLE_NATIVE_REPEATED_EMPTY_GEOMETRY", "error", `Rendered PPTX repeats visible empty geometry on slides ${Array.from(slides).join(", ")}.`, ["slides", "shapes"]));
    }
  }

  return buildReport(issues, options);
}

function expectedTextRunsForSlide(slide: PresentationSourceV1["slides"][number]): string[] {
  const values = new Set<string>();
  for (const region of slide.layoutSpec.regions) {
    if (region.slot === "title") values.add(slide.title);
    if (region.slot === "headline" && slide.headline) values.add(slide.headline);
    const bodyIndex = bodyIndexForSlot(region.slot);
    if (bodyIndex !== undefined && slide.body[bodyIndex]) values.add(slide.body[bodyIndex]);
    if (["body", "checklist", "proof", "proof-chips"].includes(region.slot)) slide.body.forEach((entry) => values.add(entry));
    if (["insight", "quote"].includes(region.slot) && slide.visualIntent) values.add(slide.visualIntent);
  }
  return Array.from(values).map((value) => value.trim()).filter((value) => value.length > 0);
}

function bodyIndexForSlot(slot: string): number | undefined {
  const letterIndex = /^column-([abc])$/.exec(slot)?.[1];
  if (letterIndex) return letterIndex.charCodeAt(0) - "a".charCodeAt(0);
  const numberedIndex = /^(card|step|option)-(\d+)$/.exec(slot)?.[2];
  if (numberedIndex) return Number.parseInt(numberedIndex, 10) - 1;
  const optionLetterIndex = /^option-([ab])$/.exec(slot)?.[1];
  if (optionLetterIndex) return optionLetterIndex.charCodeAt(0) - "a".charCodeAt(0);
  return undefined;
}

function isNonDecorativeShape(name: string): boolean {
  return !/^sw:chrome:/i.test(name);
}

function isAllowedEmptyPptxObjectName(name: string): boolean {
  return /^sw:chrome:/i.test(name) || /^sw:content:chart$/i.test(name);
}

function isVisibleEmptyShape(shape: { readonly name: string; readonly text: string; readonly x?: number; readonly y?: number; readonly cx?: number; readonly cy?: number; readonly hasVisibleEmptyShapeStyling: boolean }): boolean {
  if (shape.x === undefined || shape.y === undefined || shape.cx === undefined || shape.cy === undefined) return false;
  if (shape.text || !shape.hasVisibleEmptyShapeStyling || isAllowedEmptyPptxObjectName(shape.name)) return false;
  const areaInches = Math.abs(shape.cx / EMU_PER_INCH) * Math.abs(shape.cy / EMU_PER_INCH);
  return areaInches >= MIN_VISIBLE_EMPTY_SHAPE_AREA_INCHES;
}

function emptyShapeGeometrySignature(shape: { readonly x?: number; readonly y?: number; readonly cx?: number; readonly cy?: number; readonly prst: string }): string | null {
  if (shape.x === undefined || shape.y === undefined || shape.cx === undefined || shape.cy === undefined) return null;
  return [
    Math.round(shape.x / REPEATED_EMPTY_GEOMETRY_PRECISION),
    Math.round(shape.y / REPEATED_EMPTY_GEOMETRY_PRECISION),
    Math.round(shape.cx / REPEATED_EMPTY_GEOMETRY_PRECISION),
    Math.round(shape.cy / REPEATED_EMPTY_GEOMETRY_PRECISION),
    shape.prst,
  ].join(":");
}

function buildReport(issues: MutableQaIssue[], options: RenderQaValidationOptions): QaReport {
  const maxIssues = options.maxIssues ?? RENDER_QA_MAX_ISSUES;
  const selected = issues.length > maxIssues ? issues.slice(0, Math.max(0, maxIssues - 1)) : issues;
  const normalized = selected.map(toIssue);
  if (issues.length > maxIssues) {
    normalized.push(toIssue(issue("RENDER_QA_ISSUES_TRUNCATED", "warning", `Render QA issue output exceeded ${maxIssues}; additional issues were truncated.`, ["renderQaReport", "issues"])));
  }
  return QaReportSchema.parse({
    status: issues.some((entry) => entry.severity === "error") ? "failed" : "passed",
    issues: normalized,
    checkedAtIso: new Date().toISOString(),
    extensions: { phase: "render" },
  });
}

function issue(code: string, severity: QaIssue["severity"], message: string, path: Array<string | number>, slideId?: string): MutableQaIssue {
  return { code, severity, message, path, slideId };
}

function toIssue(input: MutableQaIssue): QaIssue {
  return {
    code: input.code.trim().slice(0, 80),
    severity: input.severity,
    message: input.message.trim().slice(0, 500),
    slideId: input.slideId?.trim().slice(0, 80),
    path: input.path.slice(0, 16),
  };
}
