import assert from "node:assert/strict";
import { test } from "vitest";
import { basicProductOverviewFixture, invalidLayoutSpecFixture } from "../__fixtures__";
import {
  deriveLayoutId,
  getLayoutFamilyDefinition,
  layoutFamilyIds,
  resolveLayoutSpec,
  validateLayoutSequence,
  validateLayoutSpec,
} from "./layout-system";
import type { LayoutSpec } from "./schemas";

test("layout registry exposes required v1 families", () => {
  assert.deepEqual(layoutFamilyIds, [
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
  ]);

  for (const familyId of layoutFamilyIds) {
    const definition = getLayoutFamilyDefinition(familyId);
    assert.equal(definition.id, familyId);
    assert.ok(definition.minTextCapacity > 0);
  }
});

test("layout validator rejects invalid LayoutSpec before render", () => {
  const invalidSlide = invalidLayoutSpecFixture.slides[0]!;
  const result = resolveLayoutSpec(invalidSlide.layoutSpec, { slideRole: invalidSlide.role });

  assert.equal(result.accepted, false);
  assert.equal(result.layoutId, "cover--cover-safe-fallback");
  assert.equal(result.fallbackApplied, true);
  assert.equal(result.spec.name, "cover-safe-fallback");
  assert.match(result.issues.map((issue) => issue.code).join("\n"), /LAYOUT_SPEC_INVALID/);
  assert.match(result.issues.map((issue) => issue.code).join("\n"), /LAYOUT_REGION_OUT_OF_BOUNDS/);
});

test("adjacent identical layout IDs are flagged as warnings", () => {
  const slides = basicProductOverviewFixture.slides.slice(0, 2).map((slide) => ({
    slideId: slide.id,
    layoutSpec: { ...slide.layoutSpec, kind: "locked", name: "two-column" } satisfies LayoutSpec,
  }));

  const result = validateLayoutSequence(slides);

  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]!.severity, "warning");
  assert.equal(result.issues[0]!.code, "LAYOUT_ADJACENT_REPEAT_RISK");
  assert.equal(result.issues[0]!.layoutId, "two_column--two-column");
});

test("parametric process layout handles variable step counts", () => {
  for (const stepCount of [3, 4, 5]) {
    const result = resolveLayoutSpec(
      {
        kind: "parametric",
        name: "process",
        intent: `Show ${stepCount} sequential steps`,
        requiredSlots: Array.from({ length: stepCount }, (_, index) => `step-${index + 1}`),
        regions: [],
        balance: "grid",
        extensions: { stepCount },
      },
      { slideRole: "content" },
    );

    assert.equal(result.accepted, true);
    assert.equal(result.fallbackApplied, false);
    assert.equal(result.layoutId, `process--process-${stepCount}`);
    assert.deepEqual(result.spec.requiredSlots, ["title", ...Array.from({ length: stepCount }, (_, index) => `step-${index + 1}`)]);
    assert.equal(result.spec.regions.length, stepCount + 1);
    assert.deepEqual(validateLayoutSpec(result.spec, { slideRole: "content" }).issues, []);
  }
});

test("valid generated LayoutSpec input is accepted when schema and domain checks pass", () => {
  const generatedSlide = basicProductOverviewFixture.slides[2]!;
  const result = resolveLayoutSpec(generatedSlide.layoutSpec, { slideRole: generatedSlide.role });

  assert.equal(result.accepted, true);
  assert.equal(result.fallbackApplied, false);
  assert.equal(result.layoutId, "process--workflow-ribbon");
  assert.deepEqual(result.issues, []);
});

test("cover layouts must include canonical family required slots", () => {
  const coverSpec = {
    kind: "generated",
    name: "cover-title-only",
    intent: "Cover slide with title but no headline",
    requiredSlots: ["title"],
    regions: [
      { id: "cover-title", slot: "title", x: 0.08, y: 0.18, width: 0.68, height: 0.18, zIndex: 1 },
    ],
    balance: "left-weighted",
  } satisfies LayoutSpec;

  const result = validateLayoutSpec(coverSpec, { slideRole: "cover" });

  assert.equal(result.valid, false);
  assert.match(result.issues.map((issue) => issue.code).join("\n"), /LAYOUT_REQUIRED_SLOT_MISSING/);
});

test("LayoutSpec validation catches missing required slots, overlap, small regions, and image aspect risk", () => {
  const invalidSpec = {
    kind: "generated",
    name: "chart-insight",
    intent: "Chart with supporting image and insight",
    requiredSlots: ["title", "chart", "image", "insight"],
    regions: [
      { id: "title", slot: "title", x: 0.08, y: 0.08, width: 0.84, height: 0.14, zIndex: 1 },
      { id: "chart", slot: "chart", x: 0.1, y: 0.3, width: 0.5, height: 0.45, zIndex: 1 },
      { id: "overlap", slot: "caption", x: 0.2, y: 0.35, width: 0.45, height: 0.4, zIndex: 1 },
      { id: "image", slot: "image", x: 0.7, y: 0.3, width: 0.2, height: 0.04, zIndex: 1 },
    ],
    balance: "grid",
  } satisfies LayoutSpec;

  const result = validateLayoutSpec(invalidSpec, { slideRole: "data" });
  const codes = result.issues.map((issue) => issue.code).join("\n");

  assert.equal(result.valid, false);
  assert.match(codes, /LAYOUT_REQUIRED_SLOT_MISSING/);
  assert.match(codes, /LAYOUT_REGION_OVERLAP/);
  assert.match(codes, /LAYOUT_REGION_TOO_SMALL/);
  assert.match(codes, /LAYOUT_IMAGE_ASPECT_RATIO_RISK/);
  assert.equal(result.fallbackCandidate.name, "chart-insight-safe-fallback");
});

test("layout IDs are derived from LayoutSpec kind and name", () => {
  assert.equal(
    deriveLayoutId({ kind: "generated", name: "Hero Claim / Big Proof" }),
    "hero_claim--hero-claim-big-proof",
  );
});
