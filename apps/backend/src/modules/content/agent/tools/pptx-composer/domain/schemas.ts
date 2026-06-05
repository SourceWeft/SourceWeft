import { z } from "zod";

export const PRESENTATION_SOURCE_V1_SCHEMA_VERSION = "pptx-composer.v1";

export const deckLanguages = ["en", "zh", "auto"] as const;
export const deckAspectRatios = ["16:9", "16:10", "4:3"] as const;
export const deckDensities = ["airy", "balanced", "dense"] as const;
export const slideRoles = ["cover", "section", "content", "data", "comparison", "closing"] as const;
export const layoutKinds = ["locked", "parametric", "generated"] as const;
export const assetKinds = ["image", "icon", "chart", "table", "diagram"] as const;
export const qaSeverities = ["info", "warning", "error"] as const;
export const renderEngines = ["pptxgenjs-native"] as const;
export const editableCompatibilityVersions = ["native-v1"] as const;

const boundedText = (maxLength: number) => z.string().trim().min(1).max(maxLength);
const optionalBoundedText = (maxLength: number) => z.string().trim().max(maxLength).optional();
const boundedTextList = (maxItems: number, maxTextLength: number) =>
  z.array(boundedText(maxTextLength)).min(1).max(maxItems);

const hexColorSchema = z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/);

const ExtensionValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(40),
]);

const ExtensionBagSchema = z.record(z.string().trim().min(1).max(80), ExtensionValueSchema).optional();

export const RequirementAnalysisSchema = z.strictObject({
  audience: boundedText(240),
  objective: boundedText(320),
  primaryMessage: boundedText(320),
  constraints: boundedTextList(12, 240).default([]),
  successCriteria: boundedTextList(12, 240).default([]),
  language: z.enum(deckLanguages).default("auto"),
  extensions: ExtensionBagSchema,
});

export const ContentBriefSchema = z.strictObject({
  title: boundedText(180),
  subtitle: optionalBoundedText(280),
  narrativeArc: boundedTextList(12, 180),
  keyPoints: boundedTextList(24, 260),
  sourceSummary: optionalBoundedText(2000),
  extensions: ExtensionBagSchema,
});

export const DeckStrategySchema = z.strictObject({
  deckTitle: boundedText(180),
  audienceTakeaway: boundedText(320),
  storyBeats: boundedTextList(16, 220),
  slideCountTarget: z.number().int().min(1).max(40),
  pacing: z.enum(["direct", "balanced", "cinematic"] as const).default("balanced"),
  extensions: ExtensionBagSchema,
});

export const TypographyTokenSchema = z.strictObject({
  family: boundedText(120),
  scale: z.enum(["compact", "standard", "expressive"] as const).default("standard"),
});

export const DeckDesignSystemSchema = z.strictObject({
  name: boundedText(120),
  aspectRatio: z.enum(deckAspectRatios),
  language: z.enum(deckLanguages).default("auto"),
  palette: z.strictObject({
    background: hexColorSchema,
    foreground: hexColorSchema,
    accent: hexColorSchema,
    muted: hexColorSchema,
    surface: hexColorSchema,
  }),
  typography: TypographyTokenSchema,
  density: z.enum(deckDensities).default("balanced"),
  layoutPrinciples: boundedTextList(10, 180),
  brandNotes: optionalBoundedText(800),
  extensions: ExtensionBagSchema,
});

export const AssetPlanItemSchema = z.strictObject({
  id: boundedText(80),
  kind: z.enum(assetKinds),
  purpose: boundedText(240),
  description: boundedText(500),
  required: z.boolean().default(false),
  sourceArtifactId: optionalBoundedText(128),
  altText: optionalBoundedText(240),
  extensions: ExtensionBagSchema,
});

export const AssetPlanSchema = z.strictObject({
  items: z.array(AssetPlanItemSchema).max(80).default([]),
  notes: optionalBoundedText(1000),
  extensions: ExtensionBagSchema,
});

export const LayoutRegionSchema = z.strictObject({
  id: boundedText(80),
  slot: boundedText(80),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0.01).max(1),
  height: z.number().min(0.01).max(1),
  zIndex: z.number().int().min(0).max(100).default(0),
});

export const LayoutSpecSchema = z.strictObject({
  kind: z.enum(layoutKinds),
  name: boundedText(120),
  intent: boundedText(260),
  requiredSlots: boundedTextList(12, 80),
  regions: z.array(LayoutRegionSchema).min(1).max(24),
  balance: z.enum(["left-weighted", "right-weighted", "centered", "grid"] as const).default("centered"),
  extensions: ExtensionBagSchema,
});

export const SlideInstructionSchema = z.strictObject({
  id: boundedText(80),
  role: z.enum(slideRoles),
  title: boundedText(220),
  headline: optionalBoundedText(260),
  body: z.array(boundedText(320)).max(8).default([]),
  speakerNotes: optionalBoundedText(1200),
  visualIntent: optionalBoundedText(500),
  layoutSpec: LayoutSpecSchema,
  assetRefs: z.array(boundedText(80)).max(20).default([]),
  extensions: ExtensionBagSchema,
});

export const QaIssueSchema = z.strictObject({
  code: boundedText(80),
  severity: z.enum(qaSeverities),
  message: boundedText(500),
  slideId: optionalBoundedText(80),
  path: z.array(z.union([z.string(), z.number()])).max(16).default([]),
});

export const QaReportSchema = z.strictObject({
  status: z.enum(["not_run", "passed", "failed"] as const),
  issues: z.array(QaIssueSchema).max(200).default([]),
  checkedAtIso: optionalBoundedText(40),
  extensions: ExtensionBagSchema,
});

export const EditablePrimitiveCountsSchema = z.strictObject({
  textBoxes: z.number().int().min(0).max(500),
  shapes: z.number().int().min(0).max(500),
  images: z.number().int().min(0).max(500),
  tables: z.number().int().min(0).max(100),
  charts: z.number().int().min(0).max(100),
});

export const SlideEditablePrimitiveCountsSchema = EditablePrimitiveCountsSchema.extend({
  slideId: boundedText(80),
});

export const RenderMetadataSchema = z.strictObject({
  engine: z.enum(renderEngines),
  generatedAtIso: optionalBoundedText(40),
  sourceHash: optionalBoundedText(128),
  slideCount: z.number().int().min(0).max(40),
  editableCompatibility: z.enum(editableCompatibilityVersions).optional(),
  editablePrimitiveCountsBySlide: z.array(SlideEditablePrimitiveCountsSchema).max(40).optional(),
  warnings: z.array(boundedText(240)).max(50).default([]),
  extensions: ExtensionBagSchema,
});

export const PresentationSourceV1Schema = z.strictObject({
  schemaVersion: z.literal(PRESENTATION_SOURCE_V1_SCHEMA_VERSION),
  requirementAnalysis: RequirementAnalysisSchema,
  contentBrief: ContentBriefSchema,
  deckStrategy: DeckStrategySchema,
  designSystem: DeckDesignSystemSchema,
  assetPlan: AssetPlanSchema,
  slides: z.array(SlideInstructionSchema).min(1).max(40),
  qaReport: QaReportSchema.default({ status: "not_run", issues: [] }),
  renderMetadata: RenderMetadataSchema.optional(),
  extensions: ExtensionBagSchema,
});

export type RequirementAnalysis = z.infer<typeof RequirementAnalysisSchema>;
export type ContentBrief = z.infer<typeof ContentBriefSchema>;
export type DeckStrategy = z.infer<typeof DeckStrategySchema>;
export type DeckDesignSystem = z.infer<typeof DeckDesignSystemSchema>;
export type AssetPlan = z.infer<typeof AssetPlanSchema>;
export type SlideInstruction = z.infer<typeof SlideInstructionSchema>;
export type LayoutSpec = z.infer<typeof LayoutSpecSchema>;
export type QaReport = z.infer<typeof QaReportSchema>;
export type EditablePrimitiveCounts = z.infer<typeof EditablePrimitiveCountsSchema>;
export type SlideEditablePrimitiveCounts = z.infer<typeof SlideEditablePrimitiveCountsSchema>;
export type RenderMetadata = z.infer<typeof RenderMetadataSchema>;
export type PresentationSourceV1 = z.infer<typeof PresentationSourceV1Schema>;
