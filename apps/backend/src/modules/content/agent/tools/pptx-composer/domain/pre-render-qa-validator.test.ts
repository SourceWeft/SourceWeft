import assert from "node:assert/strict";
import { test } from "vitest";
import {
  basicProductOverviewFixture,
  brandLowContrastFixture,
  invalidLayoutSpecFixture,
  repetitiveSlidesFixture,
} from "../__fixtures__";
import type { PresentationSourceV1 } from "./schemas";
import {
  PRE_RENDER_QA_MAX_ISSUES,
  validatePreRenderQa,
  validatePreRenderQaInput,
} from "./pre-render-qa-validator";

function issueCodesFor(source: PresentationSourceV1) {
  return validatePreRenderQa({ source }).issues.map((issue) => issue.code);
}

test("pre-render QA passes basic-product-overview fixture", () => {
  const report = validatePreRenderQa({ source: basicProductOverviewFixture });

  assert.equal(report.status, "passed");
  assert.equal(report.issues.some((issue) => issue.severity === "error"), false);
  assert.match(report.checkedAtIso ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("pre-render QA maps schema and layout validator issues into QaReport", () => {
  const report = validatePreRenderQaInput({ source: invalidLayoutSpecFixture });
  const codes = report.issues.map((issue) => issue.code);

  assert.equal(report.status, "failed");
  assert.ok(codes.includes("LAYOUT_SPEC_INVALID"));
  assert.ok(codes.includes("LAYOUT_REGION_OUT_OF_BOUNDS"));
  assert.ok(report.issues.every((issue) => issue.message.length <= 500));
  assert.ok(report.issues.every((issue) => issue.path.length <= 16));
});

test("pre-render QA maps style token violations", () => {
  const report = validatePreRenderQa({ source: brandLowContrastFixture });

  const styleIssue = report.issues.find((issue) => issue.code === "STYLE_TOKEN_CONTRAST_REPAIRED");

  assert.equal(report.status, "passed");
  assert.equal(styleIssue?.severity, "warning");
});

test("pre-render QA blocks repetitive slide structure", () => {
  const report = validatePreRenderQa({ source: repetitiveSlidesFixture });
  const codes = report.issues.map((issue) => issue.code);

  assert.equal(report.status, "failed");
  assert.ok(codes.includes("LAYOUT_DIVERSITY_TOO_LOW"));
  assert.ok(codes.includes("LAYOUT_ADJACENT_REPEAT_RISK"));
  assert.ok(report.issues.find((issue) => issue.code === "LAYOUT_DIVERSITY_TOO_LOW")?.message.includes("Repair hint:"));
});

test("pre-render QA blocks empty required slots", () => {
  const emptySlotSource = {
    ...basicProductOverviewFixture,
    slides: [
      {
        ...basicProductOverviewFixture.slides[1]!,
        body: [],
      },
    ],
  } satisfies PresentationSourceV1;

  const report = validatePreRenderQa({ source: emptySlotSource });

  assert.equal(report.status, "failed");
  assert.ok(report.issues.some((issue) => issue.code === "REQUIRED_SLOT_EMPTY"));
  assert.ok(report.issues.find((issue) => issue.code === "REQUIRED_SLOT_EMPTY")?.message.includes("Repair hint:"));
});

test("pre-render QA blocks partially empty indexed body slots", () => {
  const source = {
    ...basicProductOverviewFixture,
    slides: [
      {
        ...basicProductOverviewFixture.slides[1]!,
        body: ["Only the first column has content"],
      },
    ],
  } satisfies PresentationSourceV1;

  const report = validatePreRenderQa({ source });
  const emptySlotIssues = report.issues.filter((issue) => issue.code === "REQUIRED_SLOT_EMPTY");

  assert.equal(report.status, "failed");
  assert.ok(emptySlotIssues.some((issue) => issue.message.includes("column-b")));
  assert.ok(emptySlotIssues.some((issue) => issue.message.includes("column-c")));
});

test("pre-render QA blocks asset slots without matching declared asset kind", () => {
  const source = {
    ...basicProductOverviewFixture,
    assetPlan: {
      items: [
        {
          id: "decorative-image",
          kind: "image",
          purpose: "Decorative support",
          description: "An image that cannot satisfy a chart slot",
          required: false,
        },
      ],
    },
    slides: [
      {
        ...basicProductOverviewFixture.slides[1]!,
        body: [],
        assetRefs: ["decorative-image"],
        layoutSpec: {
          ...basicProductOverviewFixture.slides[1]!.layoutSpec,
          name: "chart-insight",
          requiredSlots: ["title", "chart"],
          regions: [
            { id: "chart-title", slot: "title", x: 0.08, y: 0.08, width: 0.84, height: 0.12, zIndex: 1 },
            { id: "chart-main", slot: "chart", x: 0.08, y: 0.28, width: 0.54, height: 0.46, zIndex: 1 },
          ],
          balance: "right-weighted",
        },
      },
    ],
  } satisfies PresentationSourceV1;

  const report = validatePreRenderQa({ source });

  assert.equal(report.status, "failed");
  assert.ok(report.issues.some((issue) => issue.code === "REQUIRED_SLOT_EMPTY" && issue.message.includes("chart")));
});

test("pre-render QA flags missing asset refs, placeholder text, and overly dense content", () => {
  const denseBody = Array.from({ length: 8 }, (_, index) => `Very dense point ${index + 1} with repeated qualifiers and details that make the slide difficult to edit or read quickly.`);
  const source = {
    ...basicProductOverviewFixture,
    slides: [
      {
        ...basicProductOverviewFixture.slides[1]!,
        title: "Untitled",
        headline: "TBD",
        body: denseBody,
        assetRefs: ["missing-asset"],
      },
    ],
  } satisfies PresentationSourceV1;

  const codes = issueCodesFor(source);

  assert.ok(codes.includes("ASSET_REF_MISSING"));
  assert.ok(codes.includes("PLACEHOLDER_TEXT_PRESENT"));
  assert.ok(codes.includes("CONTENT_TOO_DENSE"));
});

test("pre-render QA flags generic title ratio", () => {
  const source = {
    ...basicProductOverviewFixture,
    slides: basicProductOverviewFixture.slides.map((slide, index) => ({
      ...slide,
      title: `Overview ${index + 1}`,
    })),
  } satisfies PresentationSourceV1;

  const report = validatePreRenderQa({ source });

  assert.ok(report.issues.some((issue) => issue.code === "GENERIC_TITLE_RATIO_HIGH"));
});

test("pre-render QA supports failFast", () => {
  const report = validatePreRenderQa({ source: repetitiveSlidesFixture, options: { failFast: true } });

  assert.equal(report.status, "failed");
  assert.equal(report.issues.length, 1);
  assert.equal(report.issues[0]!.severity, "error");
});

test("pre-render QA caps issues and reserves the last slot for truncation", () => {
  const slides = Array.from({ length: 40 }, (_, index) => ({
    ...basicProductOverviewFixture.slides[1]!,
    id: `dense-${index + 1}`,
    title: "Untitled",
    headline: "TBD",
    body: [],
    assetRefs: [`missing-${index + 1}`],
  }));
  const source = {
    ...basicProductOverviewFixture,
    deckStrategy: {
      ...basicProductOverviewFixture.deckStrategy,
      slideCountTarget: 40,
    },
    slides,
  } satisfies PresentationSourceV1;

  const report = validatePreRenderQa({ source });

  assert.equal(report.issues.length, PRE_RENDER_QA_MAX_ISSUES);
  assert.equal(report.issues.at(-1)?.code, "QA_ISSUES_TRUNCATED");
  assert.equal(report.issues.at(-1)?.severity, "warning");
});

test("pre-render QA status preserves hidden errors after truncation", () => {
  const slides = Array.from({ length: 40 }, (_, index) => ({
    ...basicProductOverviewFixture.slides[1]!,
    id: `warning-heavy-${index + 1}`,
    title: `Specific title ${index + 1}`,
    headline: undefined,
    body: Array.from({ length: 8 }, () => "TBD"),
    assetRefs: index === 39 ? ["missing-final-asset"] : [],
    layoutSpec: {
      kind: "locked",
      name: "section-warning-heavy",
      intent: "Title-only layout used to stress QA truncation ordering",
      requiredSlots: ["title"],
      regions: [
        { id: `warning-heavy-title-${index + 1}`, slot: "title", x: 0.12, y: 0.34, width: 0.76, height: 0.2, zIndex: 1 },
      ],
      balance: "centered",
    },
  })) satisfies PresentationSourceV1["slides"];
  const source = {
    ...basicProductOverviewFixture,
    deckStrategy: {
      ...basicProductOverviewFixture.deckStrategy,
      slideCountTarget: 40,
    },
    slides,
  } satisfies PresentationSourceV1;

  const report = validatePreRenderQa({ source });

  assert.equal(report.issues.length, PRE_RENDER_QA_MAX_ISSUES);
  assert.equal(report.issues.at(-1)?.code, "QA_ISSUES_TRUNCATED");
  assert.equal(report.status, "failed");
  assert.equal(report.issues.some((issue) => issue.severity === "error"), false);
});
