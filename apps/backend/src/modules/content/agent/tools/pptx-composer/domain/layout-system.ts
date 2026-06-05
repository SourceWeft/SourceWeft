import { LayoutSpecSchema } from "./schemas";
import type { LayoutSpec, slideRoles } from "./schemas";

export const layoutFamilyIds = [
  "cover",
  "section",
  "hero_claim",
  "two_column",
  "three_cards",
  "process",
  "comparison",
  "chart_insight",
  "quote",
  "closing",
] as const;

export type LayoutFamilyId = (typeof layoutFamilyIds)[number];

export type LayoutIssueCode =
  | "LAYOUT_SPEC_INVALID"
  | "LAYOUT_REGION_OUT_OF_BOUNDS"
  | "LAYOUT_REGION_TOO_SMALL"
  | "LAYOUT_REQUIRED_SLOT_MISSING"
  | "LAYOUT_REGION_OVERLAP"
  | "LAYOUT_TEXT_CAPACITY_RISK"
  | "LAYOUT_IMAGE_ASPECT_RATIO_RISK"
  | "LAYOUT_ADJACENT_REPEAT_RISK"
  | "LAYOUT_PROCESS_STEP_COUNT_UNSUPPORTED";

export type LayoutIssue = {
  code: LayoutIssueCode;
  severity: "warning" | "error";
  path: Array<string | number>;
  message: string;
  layoutId?: string;
  slideId?: string;
};

export type LayoutFamilyDefinition = {
  id: LayoutFamilyId;
  defaultName: string;
  requiredSlots: string[];
  minTextCapacity: number;
  fallbackSpec: LayoutSpec;
};

export type ValidateLayoutOptions = {
  slideRole?: (typeof slideRoles)[number];
};

export type LayoutValidationResult = {
  valid: boolean;
  layoutId: string;
  familyId: LayoutFamilyId;
  issues: LayoutIssue[];
  fallbackCandidate: LayoutSpec;
};

export type ResolveLayoutSpecResult = {
  accepted: boolean;
  layoutId: string;
  spec: LayoutSpec;
  issues: LayoutIssue[];
  fallbackApplied: boolean;
};

export type LayoutSequenceItem = {
  slideId: string;
  layoutSpec: LayoutSpec;
};

export type LayoutSequenceValidationResult = {
  issues: LayoutIssue[];
};

const SAFE_MARGIN = 0.05;
const MIN_REGION_WIDTH = 0.06;
const MIN_REGION_HEIGHT = 0.06;
const MAX_TEXT_CHARS_PER_REGION_AREA = 1200;
const IMAGE_MIN_ASPECT_RATIO = 0.35;
const IMAGE_MAX_ASPECT_RATIO = 3.2;

const layoutFamilyIdSet = new Set<LayoutFamilyId>(layoutFamilyIds);

const layoutFamilies: Record<LayoutFamilyId, LayoutFamilyDefinition> = {
  cover: definition("cover", "cover-safe-fallback", ["title", "headline"], 360, [
    region("cover-title", "title", 0.08, 0.18, 0.68, 0.18),
    region("cover-headline", "headline", 0.08, 0.42, 0.72, 0.16),
  ], "left-weighted"),
  section: definition("section", "section-safe-fallback", ["title"], 240, [
    region("section-title", "title", 0.12, 0.34, 0.76, 0.2),
  ]),
  hero_claim: definition("hero_claim", "hero-claim-safe-fallback", ["title", "headline"], 420, [
    region("hero-title", "title", 0.08, 0.12, 0.72, 0.14),
    region("hero-headline", "headline", 0.08, 0.34, 0.7, 0.28),
    region("hero-proof", "proof", 0.08, 0.7, 0.54, 0.12),
  ], "left-weighted"),
  two_column: definition("two_column", "two-column-safe-fallback", ["title", "column-a", "column-b"], 640, [
    region("two-title", "title", 0.08, 0.08, 0.84, 0.12),
    region("two-a", "column-a", 0.08, 0.3, 0.38, 0.44),
    region("two-b", "column-b", 0.54, 0.3, 0.38, 0.44),
  ], "grid"),
  three_cards: definition("three_cards", "three-cards-safe-fallback", ["title", "card-1", "card-2", "card-3"], 760, [
    region("cards-title", "title", 0.08, 0.08, 0.84, 0.12),
    region("card-1", "card-1", 0.08, 0.32, 0.25, 0.34),
    region("card-2", "card-2", 0.38, 0.32, 0.25, 0.34),
    region("card-3", "card-3", 0.68, 0.32, 0.25, 0.34),
  ], "grid"),
  process: definition("process", "process-safe-fallback", ["title", "step-1", "step-2", "step-3"], 300, buildProcessRegions(3), "grid"),
  comparison: definition("comparison", "comparison-safe-fallback", ["title", "option-a", "option-b"], 680, [
    region("compare-title", "title", 0.08, 0.08, 0.84, 0.12),
    region("compare-a", "option-a", 0.08, 0.3, 0.38, 0.44),
    region("compare-b", "option-b", 0.54, 0.3, 0.38, 0.44),
  ], "grid"),
  chart_insight: definition("chart_insight", "chart-insight-safe-fallback", ["title", "chart", "insight"], 520, [
    region("chart-title", "title", 0.08, 0.08, 0.84, 0.12),
    region("chart-main", "chart", 0.08, 0.28, 0.54, 0.46),
    region("chart-insight", "insight", 0.68, 0.32, 0.24, 0.34),
  ], "right-weighted"),
  quote: definition("quote", "quote-safe-fallback", ["quote", "attribution"], 360, [
    region("quote-text", "quote", 0.14, 0.24, 0.72, 0.28),
    region("quote-attribution", "attribution", 0.2, 0.6, 0.6, 0.1),
  ]),
  closing: definition("closing", "closing-safe-fallback", ["title", "headline"], 420, [
    region("closing-title", "title", 0.1, 0.14, 0.8, 0.16),
    region("closing-headline", "headline", 0.16, 0.38, 0.68, 0.16),
    region("closing-action", "next-step", 0.22, 0.62, 0.56, 0.16),
  ]),
};

export function getLayoutFamilyDefinition(familyId: LayoutFamilyId): LayoutFamilyDefinition {
  return cloneDefinition(layoutFamilies[familyId]);
}

export function deriveLayoutId(spec: Pick<LayoutSpec, "kind" | "name">): string {
  const slug = slugify(spec.name);
  return `${inferLayoutFamilyId(spec.name)}--${slug}`;
}

export function validateLayoutSpec(input: unknown, options: ValidateLayoutOptions = {}): LayoutValidationResult {
  const parsed = parseLayoutSpecInput(input);

  if (!parsed.success) {
    const familyId = fallbackFamilyForRole(options.slideRole);
    return {
      valid: false,
      layoutId: `${familyId}--invalid`,
      familyId,
      issues: issuesFromSchemaError(parsed.error.issues),
      fallbackCandidate: fallbackForFamily(familyId),
    };
  }

  const spec = maybeGenerateParametricSpec(parsed.data);
  const familyId = inferLayoutFamilyId(spec.name);
  const layoutId = deriveLayoutId(spec);
  const issues = collectLayoutIssues(spec, familyId, layoutId);

  return {
    valid: issues.every((issue) => issue.severity !== "error"),
    layoutId,
    familyId,
    issues,
    fallbackCandidate: fallbackForFamily(familyId),
  };
}

export function resolveLayoutSpec(input: unknown, options: ValidateLayoutOptions = {}): ResolveLayoutSpecResult {
  const parsed = parseLayoutSpecInput(input);
  if (!parsed.success) {
    const familyId = fallbackFamilyForRole(options.slideRole);
    const spec = fallbackForFamily(familyId);
    return {
      accepted: false,
      layoutId: deriveLayoutId(spec),
      spec,
      issues: issuesFromSchemaError(parsed.error.issues),
      fallbackApplied: true,
    };
  }

  const spec = maybeGenerateParametricSpec(parsed.data);
  const validation = validateLayoutSpec(spec, options);

  if (validation.valid) {
    return {
      accepted: true,
      layoutId: validation.layoutId,
      spec,
      issues: validation.issues,
      fallbackApplied: false,
    };
  }

  return {
    accepted: false,
    layoutId: deriveLayoutId(validation.fallbackCandidate),
    spec: validation.fallbackCandidate,
    issues: validation.issues,
    fallbackApplied: true,
  };
}

export function validateLayoutSequence(slides: LayoutSequenceItem[]): LayoutSequenceValidationResult {
  const issues: LayoutIssue[] = [];
  let previousLayoutId: string | undefined;

  slides.forEach((slide, index) => {
    const layoutId = deriveLayoutId(slide.layoutSpec);
    if (index > 0 && layoutId === previousLayoutId) {
      issues.push({
        code: "LAYOUT_ADJACENT_REPEAT_RISK",
        severity: "warning",
        path: [index, "layoutSpec"],
        message: "Adjacent slides use the same layout ID.",
        layoutId,
        slideId: slide.slideId,
      });
    }
    previousLayoutId = layoutId;
  });

  return { issues };
}

function parseLayoutSpecInput(input: unknown): ReturnType<typeof LayoutSpecSchema.safeParse> {
  const parsed = LayoutSpecSchema.safeParse(input);
  if (parsed.success || !isParametricProcessDraft(input)) {
    return parsed;
  }

  return LayoutSpecSchema.safeParse({
    ...input,
    regions: buildProcessRegions(readStepCountFromDraft(input)),
  });
}

function isParametricProcessDraft(input: unknown): input is LayoutSpec {
  if (!input || typeof input !== "object") {
    return false;
  }
  const candidate = input as { kind?: unknown; name?: unknown; regions?: unknown };
  return candidate.kind === "parametric" && typeof candidate.name === "string" && inferLayoutFamilyId(candidate.name) === "process" && Array.isArray(candidate.regions) && candidate.regions.length === 0;
}

function readStepCountFromDraft(input: LayoutSpec): number {
  const extensionStepCount = input.extensions?.stepCount;
  if (typeof extensionStepCount === "number" && Number.isInteger(extensionStepCount)) {
    return extensionStepCount;
  }
  if (Array.isArray(input.requiredSlots)) {
    return input.requiredSlots.filter((slot) => /^step-\d+$/.test(slot)).length || 3;
  }
  return 3;
}

function issuesFromSchemaError(issues: ReadonlyArray<{ path: Array<PropertyKey>; message: string }>): LayoutIssue[] {
  const schemaIssues: LayoutIssue[] = [
    {
      code: "LAYOUT_SPEC_INVALID",
      severity: "error",
      path: [],
      message: "LayoutSpec did not pass schema validation.",
    },
  ];

  for (const issue of issues) {
    const path = issue.path.filter((part) => typeof part === "string" || typeof part === "number");
    schemaIssues.push({
      code: isRegionCoordinatePath(path) ? "LAYOUT_REGION_OUT_OF_BOUNDS" : "LAYOUT_SPEC_INVALID",
      severity: "error",
      path,
      message: issue.message,
    });
  }

  return schemaIssues;
}

function isRegionCoordinatePath(path: Array<string | number>): boolean {
  const last = path[path.length - 1];
  return path.includes("regions") && (last === "x" || last === "y" || last === "width" || last === "height");
}

function maybeGenerateParametricSpec(spec: LayoutSpec): LayoutSpec {
  const familyId = inferLayoutFamilyId(spec.name);
  if (spec.kind !== "parametric" || familyId !== "process") {
    return cloneSpec(spec);
  }

  const stepCount = readStepCount(spec);
  if (![3, 4, 5].includes(stepCount)) {
    return cloneSpec(spec);
  }

  return {
    ...cloneSpec(spec),
    name: `process-${stepCount}`,
    requiredSlots: ["title", ...stepSlots(stepCount)],
    regions: buildProcessRegions(stepCount),
    balance: "grid",
  };
}

function collectLayoutIssues(spec: LayoutSpec, familyId: LayoutFamilyId, layoutId: string): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const requiredSlots = new Set(spec.requiredSlots);
  const regionSlots = new Set(spec.regions.map((regionItem) => regionItem.slot));

  if (spec.kind === "parametric" && familyId === "process" && ![3, 4, 5].includes(readStepCount(spec))) {
    issues.push(errorIssue("LAYOUT_PROCESS_STEP_COUNT_UNSUPPORTED", ["extensions", "stepCount"], "Process layouts support 3, 4, or 5 steps.", layoutId));
  }

  for (const slot of requiredSlots) {
    if (!regionSlots.has(slot)) {
      issues.push(errorIssue("LAYOUT_REQUIRED_SLOT_MISSING", ["requiredSlots", slot], `Required slot ${slot} has no region.`, layoutId));
    }
  }

  for (const slot of layoutFamilies[familyId].requiredSlots) {
    if (!requiredSlots.has(slot)) {
      issues.push(errorIssue("LAYOUT_REQUIRED_SLOT_MISSING", ["requiredSlots", slot], `Canonical required slot ${slot} is not declared.`, layoutId));
    } else if (!regionSlots.has(slot)) {
      issues.push(errorIssue("LAYOUT_REQUIRED_SLOT_MISSING", ["regions", slot], `Canonical required slot ${slot} has no region.`, layoutId));
    }
  }

  spec.regions.forEach((regionItem, index) => {
    if (!isInsideSafeArea(regionItem)) {
      issues.push(errorIssue("LAYOUT_REGION_OUT_OF_BOUNDS", ["regions", index], "Region must stay inside safe area.", layoutId));
    }
    if (regionItem.width < MIN_REGION_WIDTH || regionItem.height < MIN_REGION_HEIGHT) {
      issues.push(errorIssue("LAYOUT_REGION_TOO_SMALL", ["regions", index], "Region is below minimum readable size.", layoutId));
    }
    if (isImageSlot(regionItem.slot)) {
      const ratio = regionItem.width / regionItem.height;
      if (ratio < IMAGE_MIN_ASPECT_RATIO || ratio > IMAGE_MAX_ASPECT_RATIO) {
        issues.push(errorIssue("LAYOUT_IMAGE_ASPECT_RATIO_RISK", ["regions", index], "Image region aspect ratio is outside safe editable bounds.", layoutId));
      }
    }
  });

  for (let leftIndex = 0; leftIndex < spec.regions.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < spec.regions.length; rightIndex += 1) {
      if (regionsOverlap(spec.regions[leftIndex]!, spec.regions[rightIndex]!)) {
        issues.push(errorIssue("LAYOUT_REGION_OVERLAP", ["regions", rightIndex], "Required regions must not overlap.", layoutId));
      }
    }
  }

  const totalTextCapacity = spec.regions.reduce((sum, regionItem) => sum + regionItem.width * regionItem.height * MAX_TEXT_CHARS_PER_REGION_AREA, 0);
  if (totalTextCapacity < layoutFamilies[familyId].minTextCapacity) {
    issues.push(warningIssue("LAYOUT_TEXT_CAPACITY_RISK", ["regions"], "Layout has low text capacity for its family.", layoutId));
  }

  return issues;
}

function inferLayoutFamilyId(name: string): LayoutFamilyId {
  const normalized = slugify(name).replaceAll("-", "_");
  if (layoutFamilyIdSet.has(normalized as LayoutFamilyId)) {
    return normalized as LayoutFamilyId;
  }
  if (normalized.includes("cover")) return "cover";
  if (normalized.includes("section")) return "section";
  if (normalized.includes("hero") || normalized.includes("claim")) return "hero_claim";
  if (normalized.includes("two") || normalized.includes("column")) return "two_column";
  if (normalized.includes("three") || normalized.includes("card")) return "three_cards";
  if (normalized.includes("process") || normalized.includes("workflow") || normalized.includes("ribbon") || normalized.includes("step")) return "process";
  if (normalized.includes("comparison") || normalized.includes("compare")) return "comparison";
  if (normalized.includes("chart") || normalized.includes("insight") || normalized.includes("data")) return "chart_insight";
  if (normalized.includes("quote")) return "quote";
  if (normalized.includes("closing") || normalized.includes("close")) return "closing";
  return "two_column";
}

function fallbackFamilyForRole(role: ValidateLayoutOptions["slideRole"]): LayoutFamilyId {
  if (role === "cover") return "cover";
  if (role === "section") return "section";
  if (role === "data") return "chart_insight";
  if (role === "comparison") return "comparison";
  if (role === "closing") return "closing";
  return "two_column";
}

function fallbackForFamily(familyId: LayoutFamilyId): LayoutSpec {
  return cloneSpec(layoutFamilies[familyId].fallbackSpec);
}

function definition(
  id: LayoutFamilyId,
  defaultName: string,
  requiredSlots: string[],
  minTextCapacity: number,
  regions: LayoutSpec["regions"],
  balance: LayoutSpec["balance"] = "centered",
): LayoutFamilyDefinition {
  return {
    id,
    defaultName,
    requiredSlots,
    minTextCapacity,
    fallbackSpec: {
      kind: "locked",
      name: defaultName,
      intent: `Safe fallback layout for ${id.replaceAll("_", " ")}.`,
      requiredSlots,
      regions,
      balance,
    },
  };
}

function region(id: string, slot: string, x: number, y: number, width: number, height: number): LayoutSpec["regions"][number] {
  return { id, slot, x, y, width, height, zIndex: 1 };
}

function buildProcessRegions(stepCount: number): LayoutSpec["regions"] {
  const gap = 0.035;
  const left = 0.08;
  const width = (0.84 - gap * (stepCount - 1)) / stepCount;
  return [
    region("process-title", "title", 0.08, 0.08, 0.84, 0.12),
    ...stepSlots(stepCount).map((slot, index) =>
      region(`process-${index + 1}`, slot, round(left + index * (width + gap)), 0.34, round(width), 0.3),
    ),
  ];
}

function stepSlots(stepCount: number): string[] {
  return Array.from({ length: stepCount }, (_, index) => `step-${index + 1}`);
}

function readStepCount(spec: LayoutSpec): number {
  const extensionStepCount = spec.extensions?.stepCount;
  if (typeof extensionStepCount === "number" && Number.isInteger(extensionStepCount)) {
    return extensionStepCount;
  }
  const stepSlotCount = spec.requiredSlots.filter((slot) => /^step-\d+$/.test(slot)).length;
  return stepSlotCount || 3;
}

function isInsideSafeArea(regionItem: LayoutSpec["regions"][number]): boolean {
  return (
    regionItem.x >= SAFE_MARGIN &&
    regionItem.y >= SAFE_MARGIN &&
    regionItem.x + regionItem.width <= 1 - SAFE_MARGIN &&
    regionItem.y + regionItem.height <= 1 - SAFE_MARGIN
  );
}

function regionsOverlap(left: LayoutSpec["regions"][number], right: LayoutSpec["regions"][number]): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x && left.y < right.y + right.height && left.y + left.height > right.y;
}

function isImageSlot(slot: string): boolean {
  const normalized = slot.toLowerCase();
  return normalized.includes("image") || normalized.includes("photo") || normalized.includes("visual");
}

function errorIssue(code: LayoutIssueCode, path: Array<string | number>, message: string, layoutId: string): LayoutIssue {
  return { code, severity: "error", path, message, layoutId };
}

function warningIssue(code: LayoutIssueCode, path: Array<string | number>, message: string, layoutId: string): LayoutIssue {
  return { code, severity: "warning", path, message, layoutId };
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "layout";
}

function cloneDefinition(definitionItem: LayoutFamilyDefinition): LayoutFamilyDefinition {
  return {
    ...definitionItem,
    requiredSlots: [...definitionItem.requiredSlots],
    fallbackSpec: cloneSpec(definitionItem.fallbackSpec),
  };
}

function cloneSpec(spec: LayoutSpec): LayoutSpec {
  return {
    ...spec,
    requiredSlots: [...spec.requiredSlots],
    regions: spec.regions.map((regionItem) => ({ ...regionItem })),
    extensions: spec.extensions ? { ...spec.extensions } : undefined,
  };
}

function round(value: number): number {
  return Number(value.toFixed(4));
}
