import { createHash, randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import {
  buildArtifactStorageKey,
  getContentStorageBucketName,
  uploadArtifactObject,
} from "../../storage";
import { toObjectRecord } from "../turn/content";
import { sanitizeArtifactDownloadFileBaseName } from "../../artifacts/filenames";
import { createSlidesArtifactRecord } from "../../artifacts/repository";
import { AGENT_TOOL_NAMES } from "../tool-names";
import type { GeneratePptxToolSelection } from "../../artifacts/types";
import type { RuntimePromptContext } from "../prompts/tool-prompt-provider";
import { logger } from "../../../../shared/logger";
import {
  buildVisualDeckFontPublicUrl,
  buildVisualDeckLicensePublicUrl,
  type VisualDeckFontConfig,
  type VisualDeckFontKey,
  visualDeckFontRegistry,
} from "./visual-deck-fonts";
import {
  createComposePresentationSourceUseCase,
  PresentationComposerQaError,
  PptxGenJsRendererAdapter,
  type PresentationSourceV1,
  type QaReport,
  type RenderMetadata,
  validatePreRenderQa,
  validateRenderQa,
} from "./pptx-composer";

export const GENERATED_PPTX_PROGRESS_EVENT_TYPE = "generate_pptx_progress";

const slideKinds = [
  "title",
  "section",
  "content",
  "comparison",
  "chart",
  "table",
  "image",
  "quote",
  "closing",
] as const;

const leakedJsonSiblingFieldPattern =
  /(?:\\?["'])?\s*,\s*\\?["'](?:assets|body|brief|caption|claim|content|cover|design|footer|generationMode|intent|kicker|kind|layout|layoutHint|mode|narrativeArc|notes|output|rendering|slides|sourceArtifactIds|subtitle|templateArtifactId|title)\\?["']\s*:/i;

const visualCompositionValues = [
  "auto",
  "axis",
  "poster",
  "split",
  "notebook",
  "schematic",
  "report",
] as const;

const visualBackgroundValues = [
  "auto",
  "plain",
  "grid",
  "paper",
  "image",
  "gradient",
  "diagram",
] as const;

type VisualCompositionStyleInput = (typeof visualCompositionValues)[number];
type VisualBackgroundTreatmentInput = (typeof visualBackgroundValues)[number];

type LegacyPptxSlide = {
  background?: { color: string };
  addChart(...args: unknown[]): void;
  addNotes(notes: string): void;
  addShape(...args: unknown[]): void;
  addTable(...args: unknown[]): void;
  addText(...args: unknown[]): void;
};

type LegacyPptxDocument = {
  _slides?: LegacyPptxSlide[];
  addSlide(): LegacyPptxSlide;
  tableToSlides(...args: unknown[]): void;
};

function sanitizeToolTextInput(
  value: unknown,
  maxLength: number,
  options: { repairJsonLeakage?: boolean } = {},
) {
  if (typeof value !== "string") {
    return value;
  }

  let text = value.trim();
  if (options.repairJsonLeakage) {
    const leakedFieldIndex = text.search(leakedJsonSiblingFieldPattern);
    if (leakedFieldIndex > 0) {
      text = text
        .slice(0, leakedFieldIndex)
        .replace(/\\"/g, '"')
        .replace(/(?:\\?["']|[}\]])+$/g, "")
        .trim();
    }
  }

  return text.length > maxLength ? text.slice(0, maxLength).trimEnd() : text;
}

function toolText(
  maxLength: number,
  options: { min?: number; repairJsonLeakage?: boolean } = {},
) {
  let schema = z
    .string()
    .overwrite((value) =>
      sanitizeToolTextInput(value, maxLength, options) as string,
    )
    .max(maxLength);
  if (options.min !== undefined) {
    schema = schema.min(options.min);
  }
  return schema;
}

const stylePresetValues = [
  "executive",
  "technical",
  "editorial",
  "data-heavy",
  "custom",
] as const;

type GeneratePptxStylePreset = (typeof stylePresetValues)[number];

const stylePresetSchema = toolText(80).describe(
  "Style direction. Preferred values: executive, technical, editorial, data-heavy, or custom. Freeform style labels are normalized to custom.",
);

function toolTextListInput(maxItems: number, maxLength: number) {
  return z.union([
    z.array(toolText(maxLength, { min: 1 })).max(maxItems),
    toolText(Math.min(4000, Math.max(maxLength, maxItems * maxLength))),
  ]);
}

function normalizeVisualCompositionStyleInput(value: unknown) {
  return visualCompositionValues.includes(value as VisualCompositionStyleInput)
    ? (value as VisualCompositionStyleInput)
    : undefined;
}

function normalizeVisualBackgroundTreatmentInput(value: unknown) {
  return visualBackgroundValues.includes(value as VisualBackgroundTreatmentInput)
    ? (value as VisualBackgroundTreatmentInput)
    : undefined;
}

const visualSceneNodeSchema = z
  .object({
    kind: toolText(40).optional(),
    role: toolText(80).optional(),
    token: toolText(80).optional(),
    text: toolText(400, { repairJsonLeakage: true }).optional(),
    variant: toolText(80).optional(),
    position: toolText(40).optional(),
    emphasis: toolText(40).optional(),
  })
  .passthrough();

const slideSpecSchema = z.object({
  kind: z
    .enum(slideKinds)
    .describe("The layout role for this authored slide."),
  claim: toolText(240, { repairJsonLeakage: true }).optional(),
  title: toolText(240, { repairJsonLeakage: true }).optional(),
  kicker: toolText(160, { repairJsonLeakage: true }).optional(),
  caption: toolText(500, { repairJsonLeakage: true }).optional(),
  footer: toolText(240, { repairJsonLeakage: true }).optional(),
  intent: toolText(500, { repairJsonLeakage: true })
    .describe("Internal planning note for the slide; not rendered directly.")
    .optional(),
  body: z
    .unknown()
    .describe(
      "Visible slide payload. Use { bullets: string[] } or string[] for content/cards; 3-6 short bullets render as cards, 2-4 method/process bullets render as steps, and one long explanation renders as paragraph. Use { quote, attribution } or a string for quote slides; { rows } for tables; { data: [{ name, value }] } for charts; { columns }/left/right for comparison. Do not pass empty placeholder containers.",
    )
    .optional(),
  notes: toolText(2000, { repairJsonLeakage: true }).optional(),
  layoutHint: toolText(120, { repairJsonLeakage: true }).optional(),
  layout: z
    .object({
      pattern: toolText(120, { repairJsonLeakage: true }).optional(),
      emphasis: z
        .enum(["text", "image", "data", "quote", "process"])
        .optional(),
    })
    .passthrough()
    .optional(),
  visualScene: z
    .object({
      nodes: z.array(visualSceneNodeSchema).optional(),
      treatment: toolText(80).optional(),
    })
    .passthrough()
    .optional(),
});

const rawGeneratePptxSchema = z.object({
  title: toolText(160, { repairJsonLeakage: true })
    .describe(
      "Deck title. If omitted, content.cover.title will be used as a repair fallback.",
    )
    .optional(),
  mode: z.enum(["create", "edit", "analyze"]).default("create"),
  generationMode: z.enum(["visual_html", "editable_native"]).optional(),
  brief: toolText(8000).optional(),
  content: z
    .object({
      cover: z
        .object({
          title: toolText(240, { repairJsonLeakage: true }).optional(),
          subtitle: toolText(500, { repairJsonLeakage: true }).optional(),
          kicker: toolText(160, { repairJsonLeakage: true }).optional(),
        })
        .passthrough()
        .optional(),
      narrativeArc: toolTextListInput(20, 240).optional(),
      slides: z
        .array(slideSpecSchema)
        .max(40)
        .describe(
          "Compatibility fallback for models that place slide specs under content.slides. The tool will normalize these to the top-level slides array.",
        )
        .optional(),
    })
    .passthrough()
    .optional(),
  slides: z
    .array(slideSpecSchema)
    .max(40)
    .describe(
      "Authored final slide specs. For create requests, provide the complete deck content here: one object per slide with kind plus claim/title/body/caption/notes as needed.",
    )
    .optional(),
  templateArtifactId: z.string().trim().min(1).max(128).optional(),
  sourceArtifactIds: z
    .array(z.string().trim().min(1).max(128))
    .max(20)
    .optional(),
  assets: z
    .object({
      imageArtifactIds: z
        .array(z.string().trim().min(1).max(128))
        .max(40)
        .optional(),
      uploadedAssetIds: z
        .array(z.string().trim().min(1).max(128))
        .max(40)
        .optional(),
    })
    .passthrough()
    .optional(),
  design: z
    .object({
      language: z.enum(["zh", "en", "auto"]).optional(),
      aspectRatio: z.enum(["16:9", "16:10", "4:3"]).optional(),
      stylePreset: stylePresetSchema.optional(),
      customBrief: toolText(2000).optional(),
      visualSystem: z
        .object({
          palette: toolTextListInput(12, 80).optional(),
          typography: toolTextListInput(8, 120).optional(),
          layoutPrinciples: toolTextListInput(12, 200).optional(),
          styleFamily: z
            .enum([
              "auto",
              "swiss",
              "magazine",
              "education",
              "blueprint",
              "data-report",
              "editorial",
            ])
            .optional(),
          density: z.enum(["airy", "balanced", "dense"]).optional(),
          geometry: z
            .enum(["sharp", "soft", "editorial", "technical"])
            .optional(),
          chrome: z.enum(["minimal", "magazine", "lecture", "report"]).optional(),
          illustration: z
            .enum(["none", "icons", "diagrams", "image-led", "handdrawn"])
            .optional(),
          layoutPolicy: z
            .object({
              strict: z.boolean().optional(),
              diversity: z.enum(["normal", "high"]).optional(),
            })
            .passthrough()
            .optional(),
          coverTreatment: toolText(80).optional(),
          compositionStyle: toolText(80).optional(),
          backgroundTreatment: toolText(80).optional(),
          motifs: toolTextListInput(8, 80).optional(),
          imageDirection: toolText(1000).optional(),
          motion: toolText(1000).optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
  template: z
    .object({
      usage: z.enum(["none", "visual_reference", "layout_reference"]).optional(),
    })
    .passthrough()
    .optional(),
  output: z
    .object({
      includeSourceJson: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
  rendering: z
    .object({
      preferHtmlTables: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
});

const generatePptxSchema = rawGeneratePptxSchema;

type RawGeneratePptxArgs = z.infer<typeof generatePptxSchema>;
type RawPptxContent = NonNullable<RawGeneratePptxArgs["content"]>;
type RawPptxDesign = NonNullable<RawGeneratePptxArgs["design"]>;
type RawPptxVisualSystem = NonNullable<RawPptxDesign["visualSystem"]>;
type NormalizedPptxCover = {
  title?: string;
  subtitle?: string;
  kicker?: string;
} & Record<string, unknown>;
type NormalizedPptxContent = {
  cover?: NormalizedPptxCover;
  narrativeArc?: string[];
} & Record<string, unknown>;
type NormalizedPptxVisualSystem = {
  backgroundTreatment?: VisualBackgroundTreatmentInput;
  chrome?: "minimal" | "magazine" | "lecture" | "report";
  compositionStyle?: VisualCompositionStyleInput;
  coverTreatment?: string;
  density?: "airy" | "balanced" | "dense";
  geometry?: "sharp" | "soft" | "editorial" | "technical";
  illustration?: "none" | "icons" | "diagrams" | "image-led" | "handdrawn";
  palette?: string[];
  typography?: string[];
  layoutPrinciples?: string[];
  motifs?: string[];
  layoutPolicy?: {
    strict?: boolean;
    diversity?: "normal" | "high";
  } & Record<string, unknown>;
  styleFamily?:
    | "auto"
    | "swiss"
    | "magazine"
    | "education"
    | "blueprint"
    | "data-report"
    | "editorial";
  imageDirection?: string;
  motion?: string;
} & Record<string, unknown>;
type NormalizedPptxDesign = {
  language?: "zh" | "en" | "auto";
  aspectRatio?: "16:9" | "16:10" | "4:3";
  stylePreset?: GeneratePptxStylePreset;
  customBrief?: string;
  visualSystem?: NormalizedPptxVisualSystem;
} & Record<string, unknown>;
type GeneratePptxArgs = Omit<RawGeneratePptxArgs, "content" | "design" | "title"> & {
  content?: NormalizedPptxContent;
  design?: NormalizedPptxDesign;
  title: string;
};
type AuthoredSlideSpec = z.infer<typeof slideSpecSchema>;
type SlideSpec = AuthoredSlideSpec & { claim: string };
type ResolvedPptxLanguage = "zh" | "en";
type PptxLanguage = NonNullable<GeneratePptxArgs["design"]>["language"];
type GenerationMode = NonNullable<GeneratePptxArgs["generationMode"]>;
type InternalPptxGenerationMode = "high_quality_editable_pptx";

const INTERNAL_PPTX_GENERATION_MODE: InternalPptxGenerationMode =
  "high_quality_editable_pptx";

export type GeneratePptxSlideSpec = SlideSpec;
export type GeneratePptxToolArgs = GeneratePptxArgs;
export type VisualDeckSource = DeckSource;

function normalizeOptionalText(value: string | undefined) {
  const text = value?.trim();
  return text && text.length > 0 ? text : undefined;
}

function normalizeTextList(
  value: string[] | string | undefined,
  maxItems: number,
  maxLength: number,
) {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\n|[;,，；]/)
      : [];
  const items = rawItems
    .map((item) => sanitizeToolTextInput(item, maxLength) as string)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
  return items.length > 0 ? items : undefined;
}

function normalizeStylePreset(value: string | undefined): GeneratePptxStylePreset | undefined {
  const text = value?.trim();
  if (!text) {
    return undefined;
  }
  return stylePresetValues.includes(text as GeneratePptxStylePreset)
    ? (text as GeneratePptxStylePreset)
    : "custom";
}

function normalizeVisualSystem(
  value: RawPptxVisualSystem | undefined,
): NormalizedPptxVisualSystem | undefined {
  if (!value) {
    return undefined;
  }
  const {
    palette: rawPalette,
    typography: rawTypography,
    layoutPrinciples: rawLayoutPrinciples,
    motifs: rawMotifs,
    ...rest
  } = value;
  const visualSystem: NormalizedPptxVisualSystem = {};
  for (const [key, entry] of Object.entries(rest)) {
    if (entry !== undefined) {
      (visualSystem as Record<string, unknown>)[key] = entry;
    }
  }
  const palette = normalizeTextList(rawPalette, 12, 80);
  const typography = normalizeTextList(rawTypography, 8, 120);
  const layoutPrinciples = normalizeTextList(rawLayoutPrinciples, 12, 200);
  const motifs = normalizeTextList(rawMotifs, 8, 80);
  const compositionStyle = normalizeVisualCompositionStyleInput(
    visualSystem.compositionStyle,
  );
  const backgroundTreatment = normalizeVisualBackgroundTreatmentInput(
    visualSystem.backgroundTreatment,
  );
  if (compositionStyle) {
    visualSystem.compositionStyle = compositionStyle;
  } else {
    delete visualSystem.compositionStyle;
  }
  if (backgroundTreatment) {
    visualSystem.backgroundTreatment = backgroundTreatment;
  } else {
    delete visualSystem.backgroundTreatment;
  }
  if (palette) {
    visualSystem.palette = palette;
  } else {
    delete visualSystem.palette;
  }
  if (typography) {
    visualSystem.typography = typography;
  } else {
    delete visualSystem.typography;
  }
  if (layoutPrinciples) {
    visualSystem.layoutPrinciples = layoutPrinciples;
  } else {
    delete visualSystem.layoutPrinciples;
  }
  if (motifs) {
    visualSystem.motifs = motifs;
  } else {
    delete visualSystem.motifs;
  }
  return Object.keys(visualSystem).length > 0 ? visualSystem : undefined;
}

function normalizePptxDesign(
  value: RawGeneratePptxArgs["design"],
): NormalizedPptxDesign | undefined {
  if (!value) {
    return undefined;
  }
  const {
    stylePreset: rawStylePreset,
    visualSystem: rawVisualSystem,
    ...rest
  } = value;
  const stylePreset = normalizeStylePreset(rawStylePreset);
  const visualSystem = normalizeVisualSystem(rawVisualSystem);
  const design: NormalizedPptxDesign = {
    ...rest,
    ...(stylePreset ? { stylePreset } : {}),
    ...(visualSystem ? { visualSystem } : {}),
  };
  return Object.keys(design).length > 0 ? design : undefined;
}

function normalizePptxCover(
  value: RawPptxContent["cover"],
): NormalizedPptxCover | undefined {
  if (!value) {
    return undefined;
  }
  const cover: NormalizedPptxCover = {
    ...value,
  };
  return Object.keys(cover).length > 0 ? cover : undefined;
}

function normalizePptxContent(
  value: RawGeneratePptxArgs["content"],
): { content?: NormalizedPptxContent; slides?: AuthoredSlideSpec[] } {
  if (!value) {
    return {};
  }
  const {
    cover: rawCover,
    narrativeArc: rawNarrativeArc,
    slides,
    ...rest
  } = value;
  const cover = normalizePptxCover(rawCover);
  const narrativeArc = normalizeTextList(rawNarrativeArc, 20, 240);
  const content: NormalizedPptxContent = {
    ...rest,
    ...(cover ? { cover } : {}),
    ...(narrativeArc ? { narrativeArc } : {}),
  };
  return {
    ...(Object.keys(content).length > 0 ? { content } : {}),
    ...(slides ? { slides } : {}),
  };
}

function parseGeneratePptxArgs(input: unknown): GeneratePptxArgs {
  const parsed = generatePptxSchema.parse(input);
  const repairedTitle =
    normalizeOptionalText(parsed.title) ??
    normalizeOptionalText(parsed.content?.cover?.title);
  if (!repairedTitle) {
    throw new z.ZodError([
      {
        code: "custom",
        message: "title or content.cover.title is required",
        path: ["title"],
      },
    ]);
  }

  const {
    content: rawContent,
    design: rawDesign,
    title: _rawTitle,
    ...rest
  } = parsed;
  const normalizedContent = normalizePptxContent(rawContent);
  const contentSlides = normalizedContent.slides;
  const slides = parsed.slides ?? contentSlides;
  const design = normalizePptxDesign(rawDesign);

  return {
    ...rest,
    title: repairedTitle,
    ...(normalizedContent.content ? { content: normalizedContent.content } : {}),
    ...(design ? { design } : {}),
    ...(slides
      ? { slides: repairLeakedSlideJsonInSlides(slides) }
      : {}),
  };
}

type DeckSpec = {
  cover: {
    kicker?: string;
    subtitle?: string;
    title: string;
  };
  design: {
    aspectRatio: "16:9" | "16:10" | "4:3";
    customBrief?: string;
    language: PptxLanguage;
    resolvedLanguage: ResolvedPptxLanguage;
    stylePreset: "executive" | "technical" | "editorial" | "data-heavy" | "custom";
    visualSystem?: NonNullable<NonNullable<GeneratePptxArgs["design"]>["visualSystem"]>;
  };
  narrativeArc: string[];
  normalizationWarnings: string[];
  slides: SlideSpec[];
  template: {
    usage: "none" | "visual_reference" | "layout_reference";
  };
};

const layoutByAspectRatio = {
  "16:9": "LAYOUT_WIDE",
  "16:10": "LAYOUT_16x10",
  "4:3": "LAYOUT_4x3",
} as const;

type ZipEntry = {
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
  name: string;
  uncompressedSize: number;
};

type VisualDeckSourceLike = {
  assets?: GeneratePptxArgs["assets"];
  brief?: string;
  deckSpec: DeckSpec;
  design: DeckSpec["design"];
  slides: SlideSpec[];
  title: string;
};
type DeckSource = ReturnType<typeof normalizeDeckSource>;
type DeckTheme = {
  accent: string;
  accent2: string;
  background: string;
  bodyFont: string;
  card: string;
  chartColors: string[];
  grid: string;
  headingFont: string;
  muted: string;
  name: string;
  onAccent: string;
  sectionBackground: string;
  sectionText: string;
  text: string;
};

type VisualLayoutStyle =
  | "bento"
  | "blueprint"
  | "editorial"
  | "minimal"
  | "poster";

type VisualThemeTokens = {
  cardRadius: number;
  layout: VisualLayoutStyle;
  patternOpacity: number;
  shadow: string;
  titleScale: number;
};

type VisualSystemFamily =
  | "swiss"
  | "magazine"
  | "education"
  | "blueprint"
  | "data-report"
  | "editorial";
type VisualSystemDensity = "airy" | "balanced" | "dense";
type VisualSystemGeometry = "sharp" | "soft" | "editorial" | "technical";
type VisualSystemChrome = "minimal" | "magazine" | "lecture" | "report";
type VisualSystemIllustration =
  | "none"
  | "icons"
  | "diagrams"
  | "image-led"
  | "handdrawn";
type VisualCompositionStyle =
  | "axis"
  | "poster"
  | "split"
  | "notebook"
  | "schematic"
  | "report";
type VisualBackgroundTreatment =
  | "plain"
  | "grid"
  | "paper"
  | "image"
  | "gradient"
  | "diagram";
type VisualSceneNodeKind =
  | "text-slot"
  | "panel"
  | "shape"
  | "media-slot"
  | "diagram"
  | "metric"
  | "divider";
type VisualSceneNode = {
  emphasis: "primary" | "secondary" | "accent" | "muted";
  kind: VisualSceneNodeKind;
  position: "hero" | "left" | "right" | "top" | "bottom" | "center" | "accent";
  role: string;
  text?: string;
  token?: string;
  variant?: string;
};
type CompiledVisualScene = {
  family: VisualSystemFamily;
  layoutId: string;
  nodes: VisualSceneNode[];
  sceneId: string;
  slideIndex: number;
  treatment: string;
  warnings: string[];
};
type VisualLayoutRole =
  | "cover"
  | "section"
  | "content"
  | "comparison"
  | "chart"
  | "table"
  | "image"
  | "quote"
  | "closing";
type VisualDeckLayoutDefinition = {
  family: VisualSystemFamily;
  id: string;
  macroLayout: string;
  role: VisualLayoutRole;
  aliases: readonly string[];
};
type CompiledVisualSystem = {
  version: 3;
  backgroundTreatment: VisualBackgroundTreatment;
  compositionStyle: VisualCompositionStyle;
  coverTreatment: string;
  family: VisualSystemFamily;
  density: VisualSystemDensity;
  geometry: VisualSystemGeometry;
  chrome: VisualSystemChrome;
  illustration: VisualSystemIllustration;
  layoutPolicy: {
    strict: boolean;
    diversity: "normal" | "high";
  };
  motion: {
    preset: "calm" | "editorial" | "technical" | "kinetic";
  };
  assetPolicy: {
    imageSlots: boolean;
    illustration: VisualSystemIllustration;
    motifs: string[];
  };
  qaRules: {
    minMacroLayoutsForTenSlides: number;
    preventThreeConsecutiveMacroLayouts: boolean;
    requireRegisteredLayouts: boolean;
  };
  theme: DeckTheme;
  tokens: VisualThemeTokens;
};
type ResolvedVisualSlide = {
  contentShape: VisualSlideContentShape;
  family: VisualSystemFamily;
  imageSlot?: string;
  layoutId: string;
  macroLayout: string;
  role: VisualLayoutRole;
  slideIndex: number;
};
type VisualSlideContentShape =
  | "cards"
  | "chart"
  | "closing"
  | "comparison"
  | "cover"
  | "empty"
  | "image"
  | "paragraph"
  | "practice"
  | "quote"
  | "section"
  | "steps"
  | "table";

const visualDeckLayoutRegistry = {
  swiss: [
    { id: "swiss-cover", role: "cover", macroLayout: "cover", aliases: ["cover", "hero", "s01"] },
    { id: "swiss-timeline", role: "content", macroLayout: "timeline", aliases: ["timeline", "process", "s02", "s11"] },
    { id: "swiss-duo-compare", role: "comparison", macroLayout: "duo-compare", aliases: ["compare", "comparison", "before-after", "s08"] },
    { id: "swiss-matrix", role: "content", macroLayout: "matrix", aliases: ["matrix", "grid", "concepts", "s15"] },
    { id: "swiss-ledger", role: "chart", macroLayout: "ledger", aliases: ["ledger", "kpi", "data", "s20"] },
    { id: "swiss-image-hero", role: "image", macroLayout: "image-hero", aliases: ["image", "image-hero", "visual", "s22"] },
    { id: "swiss-closing", role: "closing", macroLayout: "closing", aliases: ["closing", "summary", "s10"] },
  ],
  magazine: [
    { id: "magazine-cover", role: "cover", macroLayout: "cover", aliases: ["cover", "hero"] },
    { id: "magazine-section-curtain", role: "section", macroLayout: "section-curtain", aliases: ["section", "curtain", "divider"] },
    { id: "magazine-quote-image", role: "quote", macroLayout: "quote-image", aliases: ["quote", "quote-image", "pullquote"] },
    { id: "magazine-image-grid", role: "image", macroLayout: "image-grid", aliases: ["image-grid", "gallery", "evidence"] },
    { id: "magazine-data-poster", role: "chart", macroLayout: "data-poster", aliases: ["data", "poster", "chart"] },
    { id: "magazine-longform", role: "content", macroLayout: "longform", aliases: ["longform", "story", "editorial"] },
    { id: "magazine-closing", role: "closing", macroLayout: "closing", aliases: ["closing", "takeaway"] },
  ],
  education: [
    { id: "education-cover", role: "cover", macroLayout: "cover", aliases: ["cover", "lesson", "classroom"] },
    { id: "education-paragraph", role: "content", macroLayout: "paragraph", aliases: ["paragraph", "longform", "explain", "正文", "长文"] },
    { id: "education-concept-map", role: "content", macroLayout: "concept-map", aliases: ["concept", "concept-map", "knowledge-map", "知识图谱"] },
    { id: "education-step-board", role: "content", macroLayout: "step-board", aliases: ["step", "steps", "method", "步骤"] },
    { id: "education-analogy", role: "content", macroLayout: "analogy", aliases: ["analogy", "example", "类比"] },
    { id: "education-practice", role: "content", macroLayout: "practice", aliases: ["practice", "exercise", "练习"] },
    { id: "education-quote", role: "quote", macroLayout: "quote", aliases: ["quote", "金句"] },
    { id: "education-summary", role: "closing", macroLayout: "summary", aliases: ["summary", "closing", "recap", "总结"] },
  ],
  blueprint: [
    { id: "blueprint-cover", role: "cover", macroLayout: "cover", aliases: ["cover", "blueprint"] },
    { id: "blueprint-architecture", role: "content", macroLayout: "architecture", aliases: ["architecture", "system", "架构"] },
    { id: "blueprint-sequence", role: "content", macroLayout: "sequence", aliases: ["sequence", "process", "flow"] },
    { id: "blueprint-system-map", role: "content", macroLayout: "system-map", aliases: ["system-map", "map", "diagram"] },
    { id: "blueprint-spec", role: "chart", macroLayout: "spec", aliases: ["spec", "technical", "benchmark"] },
    { id: "blueprint-comparison", role: "comparison", macroLayout: "comparison", aliases: ["comparison", "tradeoff", "compare"] },
  ],
  "data-report": [
    { id: "data-report-kpi-rail", role: "content", macroLayout: "kpi-rail", aliases: ["kpi", "metrics", "rail"] },
    { id: "data-report-bar-proof", role: "chart", macroLayout: "bar-proof", aliases: ["bar", "chart", "proof"] },
    { id: "data-report-table-focus", role: "table", macroLayout: "table-focus", aliases: ["table", "matrix"] },
    { id: "data-report-trend-callout", role: "chart", macroLayout: "trend-callout", aliases: ["trend", "callout"] },
    { id: "data-report-appendix", role: "closing", macroLayout: "appendix", aliases: ["appendix", "closing", "source"] },
  ],
  editorial: [
    { id: "editorial-cover", role: "cover", macroLayout: "cover", aliases: ["cover", "hero"] },
    { id: "editorial-section-curtain", role: "section", macroLayout: "section-curtain", aliases: ["section", "curtain"] },
    { id: "editorial-quote-image", role: "quote", macroLayout: "quote-image", aliases: ["quote", "voice"] },
    { id: "editorial-image-grid", role: "image", macroLayout: "image-grid", aliases: ["image", "gallery"] },
    { id: "editorial-cards", role: "content", macroLayout: "cards", aliases: ["cards", "grid", "bullet-grid"] },
    { id: "editorial-longform", role: "content", macroLayout: "longform", aliases: ["longform", "story"] },
    { id: "editorial-closing", role: "closing", macroLayout: "closing", aliases: ["closing", "takeaway"] },
  ],
} as const satisfies Record<
  VisualSystemFamily,
  readonly Omit<VisualDeckLayoutDefinition, "family">[]
>;

const deckThemes: Record<DeckSource["design"]["stylePreset"], DeckTheme> = {
  executive: {
    name: "Executive",
    background: "F6F4EF",
    card: "FFFFFF",
    text: "172026",
    muted: "687076",
    accent: "0F4C5C",
    accent2: "C17C3A",
    onAccent: "FFFFFF",
    grid: "D9D3C7",
    sectionBackground: "172026",
    sectionText: "FFFFFF",
    headingFont: "Aptos Display",
    bodyFont: "Aptos",
    chartColors: ["0F4C5C", "C17C3A", "5C677D", "7B8F67", "B85750"],
  },
  technical: {
    name: "Technical",
    background: "F4F7FB",
    card: "FFFFFF",
    text: "102033",
    muted: "5D6B7A",
    accent: "0B6E69",
    accent2: "2563EB",
    onAccent: "FFFFFF",
    grid: "CAD7E3",
    sectionBackground: "0B1F33",
    sectionText: "DDF7F4",
    headingFont: "Aptos Display",
    bodyFont: "Aptos",
    chartColors: ["0B6E69", "2563EB", "7C3AED", "0891B2", "475569"],
  },
  editorial: {
    name: "Editorial",
    background: "FFF7ED",
    card: "FFFFFF",
    text: "241C15",
    muted: "7A6658",
    accent: "B42318",
    accent2: "0E7490",
    onAccent: "FFFFFF",
    grid: "EAD8C2",
    sectionBackground: "3B1D12",
    sectionText: "FFF7ED",
    headingFont: "Georgia",
    bodyFont: "Aptos",
    chartColors: ["B42318", "0E7490", "C2410C", "6D5A42", "D97706"],
  },
  "data-heavy": {
    name: "Data-heavy",
    background: "F8FAFC",
    card: "FFFFFF",
    text: "0F172A",
    muted: "64748B",
    accent: "1D4ED8",
    accent2: "16A34A",
    onAccent: "FFFFFF",
    grid: "CBD5E1",
    sectionBackground: "0F172A",
    sectionText: "F8FAFC",
    headingFont: "Aptos Display",
    bodyFont: "Aptos",
    chartColors: ["1D4ED8", "16A34A", "9333EA", "EA580C", "0F766E"],
  },
  custom: {
    name: "Custom",
    background: "F7F8FA",
    card: "FFFFFF",
    text: "111827",
    muted: "6B7280",
    accent: "334155",
    accent2: "0EA5E9",
    onAccent: "FFFFFF",
    grid: "D1D5DB",
    sectionBackground: "111827",
    sectionText: "FFFFFF",
    headingFont: "Aptos Display",
    bodyFont: "Aptos",
    chartColors: ["334155", "0EA5E9", "14B8A6", "F59E0B", "8B5CF6"],
  },
};

const namedCustomColors: Record<string, string> = {
  amber: "F59E0B",
  black: "111111",
  blue: "2563EB",
  bone: "F5F0E8",
  charcoal: "1F2937",
  clay: "B45309",
  cobalt: "1D4ED8",
  coral: "F97316",
  cream: "FFF7ED",
  cyan: "0891B2",
  emerald: "059669",
  forest: "166534",
  gold: "D97706",
  graphite: "374151",
  gray: "9CA3AF",
  green: "16A34A",
  grey: "9CA3AF",
  indigo: "4F46E5",
  ink: "111827",
  ivory: "FFFBEB",
  lime: "84CC16",
  navy: "0F172A",
  orange: "EA580C",
  pink: "DB2777",
  purple: "7C3AED",
  red: "DC2626",
  rose: "E11D48",
  sage: "86A789",
  sand: "E7D8BE",
  slate: "475569",
  stone: "78716C",
  teal: "0F766E",
  violet: "8B5CF6",
  white: "FFFFFF",
  yellow: "EAB308",
};

function compactText(value: string, maxLength = 120) {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }
  return `${compacted.slice(0, maxLength - 3).trimEnd()}...`;
}

function hashText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function componentToHex(value: number) {
  return Math.round(Math.max(0, Math.min(255, value)))
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
}

function hslToHex(hue: number, saturation: number, lightness: number) {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - c / 2;
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];
  return `${componentToHex((r + m) * 255)}${componentToHex((g + m) * 255)}${componentToHex((b + m) * 255)}`;
}

function parseHexColor(value: string) {
  const match = value.match(/#?([0-9a-f]{6}|[0-9a-f]{3})\b/i);
  if (!match?.[1]) {
    return null;
  }
  const hex = match[1].toUpperCase();
  if (hex.length === 6) {
    return hex;
  }
  return hex
    .split("")
    .map((part) => `${part}${part}`)
    .join("");
}

function resolveColorToken(value: string, salt: string) {
  const hex = parseHexColor(value);
  if (hex) {
    return hex;
  }

  const normalized = value.toLowerCase().replace(/[^a-z0-9\s-]/g, " ");
  const words = normalized.split(/[\s-]+/).filter(Boolean);
  for (const word of words) {
    const named = namedCustomColors[word];
    if (named) {
      return named;
    }
  }

  const hash = hashText(`${salt}:${normalized}`);
  return hslToHex(hash % 360, 0.58, 0.48);
}

function hexToRgb(hex: string) {
  const normalized = parseHexColor(hex) ?? "000000";
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function relativeLuminance(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  const normalize = (value: number) => {
    const channel = value / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * normalize(r) + 0.7152 * normalize(g) + 0.0722 * normalize(b);
}

function mixHex(a: string, b: string, amount: number) {
  const left = hexToRgb(a);
  const right = hexToRgb(b);
  const mix = Math.max(0, Math.min(1, amount));
  return `${componentToHex(left.r + (right.r - left.r) * mix)}${componentToHex(left.g + (right.g - left.g) * mix)}${componentToHex(left.b + (right.b - left.b) * mix)}`;
}

function customDesignText(source: DeckSource) {
  return customDesignTextFor(source);
}

function customDesignIntentTextFor(source: VisualDeckSourceLike) {
  return [
    source.title,
    source.brief ?? "",
    source.design.customBrief ?? "",
    ...(source.design.visualSystem?.palette ?? []),
    ...(source.design.visualSystem?.typography ?? []),
    ...(source.design.visualSystem?.layoutPrinciples ?? []),
    source.design.visualSystem?.imageDirection ?? "",
    source.design.visualSystem?.motion ?? "",
    ...source.deckSpec.narrativeArc,
    ...source.slides.flatMap((slide) => [
      slide.claim,
      slide.title ?? "",
      slide.kicker ?? "",
      slide.layoutHint ?? "",
      slide.layout?.pattern ?? "",
    ]),
  ]
    .join(" ")
    .toLowerCase();
}

function customDesignTextFor(source: VisualDeckSourceLike) {
  return [
    source.title,
    source.brief ?? "",
    source.design.customBrief ?? "",
    ...(source.design.visualSystem?.palette ?? []),
    ...(source.design.visualSystem?.typography ?? []),
    ...(source.design.visualSystem?.layoutPrinciples ?? []),
    source.design.visualSystem?.styleFamily ?? "",
    source.design.visualSystem?.density ?? "",
    source.design.visualSystem?.geometry ?? "",
    source.design.visualSystem?.chrome ?? "",
    source.design.visualSystem?.illustration ?? "",
    source.design.visualSystem?.imageDirection ?? "",
    source.design.visualSystem?.motion ?? "",
    ...source.deckSpec.narrativeArc,
    ...source.slides.flatMap((slide) => [
      slide.claim,
      slide.title ?? "",
      slide.kicker ?? "",
      slide.layoutHint ?? "",
      slide.layout?.pattern ?? "",
    ]),
  ]
    .join(" ")
    .toLowerCase();
}

function customDesignRequestsDecorativeEducation(source: VisualDeckSourceLike) {
  const text = customDesignTextFor(source);
  return /handdrawn|sketch|doodle|diagram|concept-map|knowledge-map|notebook|illustration|手绘|草图|图解|概念图|知识图谱|笔记/u.test(
    text,
  );
}

function textMatchesEducationIntent(text: string) {
  return /education|classroom|lesson|learn|learning|teaching|study|training|course|feynman|student|school|教学|教育|学习|课堂|课程|培训|费曼|学生|备考|复习|知识点/u.test(
    text,
  );
}

function textExplicitlyRequestsEditorialFamily(text: string) {
  return /magazine|editorial|monocle|journal|publication|print|essay|zine|杂志风|杂志|编辑风|社论|刊物|出版|画报/u.test(
    text,
  );
}

function customPaletteFor(source: VisualDeckSourceLike) {
  const explicit = source.design.visualSystem?.palette ?? [];
  const palette = explicit.map((item) => resolveColorToken(item, source.title));
  if (palette.length >= 3) {
    return palette.slice(0, 8);
  }

  const seed = customDesignTextFor(source) || source.title;
  const hue = hashText(seed) % 360;
  return [
    ...palette,
    hslToHex(hue, 0.52, 0.16),
    hslToHex((hue + 36) % 360, 0.68, 0.48),
    hslToHex((hue + 156) % 360, 0.48, 0.42),
    hslToHex((hue + 8) % 360, 0.26, 0.92),
  ].slice(0, 8);
}

function buildCustomTheme(source: VisualDeckSourceLike): DeckTheme {
  const palette = customPaletteFor(source);
  const designText = customDesignTextFor(source);
  const byLightness = [...palette].sort(
    (a, b) => relativeLuminance(a) - relativeLuminance(b),
  );
  const darkest = byLightness[0] ?? deckThemes.custom.text;
  const lightest = byLightness.at(-1) ?? deckThemes.custom.background;
  const accents = palette
    .filter((color) => {
      const luminance = relativeLuminance(color);
      return luminance > 0.08 && luminance < 0.78;
    })
    .filter((color) => color !== darkest);
  const accent = accents[0] ?? palette[1] ?? deckThemes.custom.accent;
  const accent2 =
    accents.find((color) => color !== accent) ??
    palette[2] ??
    deckThemes.custom.accent2;
  const background =
    relativeLuminance(lightest) > 0.75
      ? lightest
      : mixHex(lightest, "FFFFFF", 0.82);
  const text =
    relativeLuminance(darkest) < 0.38
      ? darkest
      : mixHex(darkest, "000000", 0.58);
  const card = mixHex(background, "FFFFFF", 0.72);

  return {
    name: "Custom",
    background,
    card,
    text,
    muted: mixHex(text, background, 0.42),
    accent,
    accent2,
    onAccent: relativeLuminance(accent) > 0.48 ? text : "FFFFFF",
    grid: mixHex(text, background, 0.82),
    sectionBackground: text,
    sectionText: relativeLuminance(text) > 0.48 ? "111827" : "FFFFFF",
    headingFont:
      designText.includes("serif") ||
      designText.includes("editorial") ||
      designText.includes("magazine") ||
      designText.includes("衬线") ||
      designText.includes("杂志")
        ? "Georgia"
        : "Aptos Display",
    bodyFont: "Aptos",
    chartColors: Array.from(new Set([accent, accent2, ...palette])).slice(0, 6),
  };
}

function resolveVisualLayoutRole(slide: SlideSpec, index: number): VisualLayoutRole {
  if (index === 0 || slide.kind === "title") {
    return "cover";
  }
  if (slide.kind === "section") {
    return "section";
  }
  if (slide.kind === "comparison") {
    return "comparison";
  }
  if (slide.kind === "chart") {
    return "chart";
  }
  if (slide.kind === "table") {
    return "table";
  }
  if (slide.kind === "image") {
    return "image";
  }
  if (slide.kind === "quote") {
    return "quote";
  }
  if (slide.kind === "closing") {
    return "closing";
  }
  if (slide.layout?.emphasis === "data") {
    return "chart";
  }
  if (slide.layout?.emphasis === "quote") {
    return "quote";
  }
  if (slide.layout?.emphasis === "image") {
    return "image";
  }
  return "content";
}

function registeredLayoutsFor(family: VisualSystemFamily): VisualDeckLayoutDefinition[] {
  return visualDeckLayoutRegistry[family].map((layout) => ({
    ...layout,
    family,
  }));
}

function layoutMatchesPattern(
  layout: VisualDeckLayoutDefinition,
  pattern: string | undefined,
) {
  const text = pattern?.trim().toLowerCase();
  if (!text) {
    return false;
  }
  const normalized = text.replace(/[_\s]+/g, "-");
  return (
    layout.id.toLowerCase() === normalized ||
    layout.macroLayout.toLowerCase() === normalized ||
    layout.aliases.some((alias) => normalized.includes(alias.toLowerCase()))
  );
}

function textFromSlideBody(body: unknown) {
  if (typeof body === "string") {
    return body.trim();
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text.trim();
    }
  }
  return "";
}

function averageTextLength(items: string[]) {
  if (items.length === 0) {
    return 0;
  }
  return items.reduce((sum, item) => sum + item.length, 0) / items.length;
}

function classifySlideContentShape(slide: SlideSpec, index: number): VisualSlideContentShape {
  if (index === 0 || slide.kind === "title") {
    return "cover";
  }
  if (slide.kind === "section") {
    return "section";
  }
  if (slide.kind === "quote" || slide.layout?.emphasis === "quote") {
    return "quote";
  }
  if (slide.kind === "comparison") {
    return "comparison";
  }
  if (slide.kind === "chart" || slide.layout?.emphasis === "data") {
    return "chart";
  }
  if (slide.kind === "table") {
    return "table";
  }
  if (slide.kind === "image" || slide.layout?.emphasis === "image") {
    return "image";
  }
  if (slide.kind === "closing") {
    return "closing";
  }

  const bullets = bodyToBullets(slide.body);
  const textBody = textFromSlideBody(slide.body);
  const layoutText = [
    slide.claim,
    slide.title ?? "",
    slide.caption ?? "",
    slide.intent ?? "",
    slide.layout?.pattern ?? "",
    slide.layoutHint ?? "",
  ]
    .join(" ")
    .toLowerCase();
  if (bullets.length === 0 && !textBody) {
    return "empty";
  }
  if (
    /practice|exercise|action|try|练习|实践|行动|现在|开始/u.test(layoutText)
  ) {
    return "practice";
  }
  if (
    bullets.length >= 2 &&
    bullets.length <= 4 &&
    (/step|process|method|步骤|流程|方法/u.test(layoutText) ||
      bullets.every((item) => item.length <= 80))
  ) {
    return "steps";
  }
  if (bullets.length === 1 && bullets[0] && bullets[0].length >= 64) {
    return "paragraph";
  }
  if (textBody.length >= 80) {
    return "paragraph";
  }
  if (bullets.length >= 3 && bullets.length <= 6 && averageTextLength(bullets) <= 100) {
    return "cards";
  }
  if (bullets.length <= 2) {
    return "paragraph";
  }
  return "cards";
}

function layoutForMacro(
  layouts: VisualDeckLayoutDefinition[],
  macroLayout: string,
) {
  return layouts.find((layout) => layout.macroLayout === macroLayout);
}

function layoutForContentShape(input: {
  contentShape: VisualSlideContentShape;
  layouts: VisualDeckLayoutDefinition[];
  role: VisualLayoutRole;
  system: CompiledVisualSystem;
}) {
  const { contentShape, layouts, role, system } = input;
  if (system.family === "education" && role === "content") {
    if (contentShape === "paragraph" || contentShape === "empty") {
      return layoutForMacro(layouts, "paragraph");
    }
    if (contentShape === "steps") {
      return layoutForMacro(layouts, "step-board");
    }
    if (contentShape === "practice") {
      return layoutForMacro(layouts, "practice");
    }
    if (contentShape === "cards") {
      return layoutForMacro(layouts, "concept-map");
    }
  }
  if (
    (system.family === "magazine" || system.family === "editorial") &&
    contentShape === "cards"
  ) {
    return (
      layoutForMacro(layouts, "cards") ??
      layoutForMacro(layouts, "matrix") ??
      layoutForMacro(layouts, "longform")
    );
  }
  if (
    (system.family === "magazine" || system.family === "editorial") &&
    contentShape === "paragraph"
  ) {
    return layoutForMacro(layouts, "longform");
  }
  if (system.family === "swiss" && role === "content") {
    return layoutForMacro(
      layouts,
      contentShape === "steps" ? "timeline" : "matrix",
    );
  }
  if (system.family === "data-report" && role === "content") {
    return layoutForMacro(layouts, "kpi-rail");
  }
  if (system.family === "blueprint" && role === "content") {
    return layoutForMacro(
      layouts,
      contentShape === "steps" ? "sequence" : "architecture",
    );
  }
  return undefined;
}

function fallbackLayoutForRole(
  layouts: VisualDeckLayoutDefinition[],
  role: VisualLayoutRole,
) {
  return (
    layouts.find((layout) => layout.role === role) ??
    (role === "section"
      ? layouts.find((layout) => layout.role === "cover")
      : undefined) ??
    (role === "table"
      ? layouts.find((layout) => layout.role === "chart")
      : undefined) ??
    layouts.find((layout) => layout.role === "content") ??
    layouts[0]
  );
}

function resolveSafeLayout(input: {
  contentShape: VisualSlideContentShape;
  index: number;
  layouts: VisualDeckLayoutDefinition[];
  previousMacroLayouts: string[];
  preferred?: VisualDeckLayoutDefinition;
  role: VisualLayoutRole;
  system: CompiledVisualSystem;
}) {
  const shaped =
    input.preferred ??
    layoutForContentShape({
      contentShape: input.contentShape,
      layouts: input.layouts,
      role: input.role,
      system: input.system,
    }) ??
    fallbackLayoutForRole(input.layouts, input.role) ??
    input.layouts[0];

  if (!shaped) {
    return shaped;
  }

  const lastTwo = input.previousMacroLayouts.slice(-2);
  if (
    lastTwo.length === 2 &&
    lastTwo[0] === shaped.macroLayout &&
    lastTwo[1] === shaped.macroLayout
  ) {
    const isSafeAlternate = (layout: VisualDeckLayoutDefinition) => {
      if (
        input.system.family === "education" &&
        input.contentShape === "paragraph"
      ) {
        return layout.macroLayout !== "concept-map";
      }
      if (
        input.system.family === "education" &&
        input.contentShape === "steps"
      ) {
        return ["step-board", "practice", "paragraph"].includes(
          layout.macroLayout,
        );
      }
      return true;
    };
    const alternate =
      input.layouts.find(
        (layout) =>
          layout.role === shaped.role &&
          layout.macroLayout !== shaped.macroLayout &&
          isSafeAlternate(layout),
      ) ??
      input.layouts.find(
        (layout) =>
          layout.role === "content" &&
          layout.macroLayout !== shaped.macroLayout &&
          isSafeAlternate(layout),
      );
    if (alternate) {
      return alternate;
    }
  }

  return shaped;
}

function resolveVisualSlides(
  source: VisualDeckSourceLike,
  system = compileVisualSystem(source),
) {
  const layouts = registeredLayoutsFor(system.family);
  const warnings: string[] = [];
  const previousMacroLayouts: string[] = [];
  const resolvedSlides = source.slides.map((slide, index): ResolvedVisualSlide => {
    const role = resolveVisualLayoutRole(slide, index);
    const pattern = slide.layout?.pattern ?? slide.layoutHint;
    const preferred = layouts.find((layout) => layoutMatchesPattern(layout, pattern));
    const contentShape = classifySlideContentShape(slide, index);
    const layout = resolveSafeLayout({
      contentShape,
      index,
      layouts,
      previousMacroLayouts,
      preferred,
      role,
      system,
    });
    if (!preferred && pattern?.trim()) {
      warnings.push(
        `slide_${index + 1}_layout_pattern_unregistered: "${compactText(pattern, 80)}" mapped to ${layout?.id ?? "fallback"}.`,
      );
    }
    const imageSlot =
      role === "image" || layout?.role === "image"
        ? `${layout?.id ?? system.family}-image-${source.design.aspectRatio.replace(":", "x")}`
        : undefined;
    const resolvedSlide = {
      contentShape,
      family: system.family,
      imageSlot,
      layoutId: layout?.id ?? `${system.family}-content`,
      macroLayout: layout?.macroLayout ?? "content",
      role,
      slideIndex: index,
    };
    previousMacroLayouts.push(resolvedSlide.macroLayout);
    return resolvedSlide;
  });
  return {
    resolvedSlides,
    warnings,
  };
}

function validateVisualDeckSource(input: {
  source: VisualDeckSourceLike;
  system: CompiledVisualSystem;
  resolvedSlides: ResolvedVisualSlide[];
}) {
  const warnings: string[] = [];
  const registeredIds = new Set<string>(
    registeredLayoutsFor(input.system.family).map((layout) => layout.id),
  );
  for (const slide of input.resolvedSlides) {
    if (!registeredIds.has(slide.layoutId)) {
      warnings.push(
        `slide_${slide.slideIndex + 1}_layout_unregistered: ${slide.layoutId}`,
      );
    }
  }

  const macroLayouts = input.resolvedSlides.map((slide) => slide.macroLayout);
  const distinctMacroLayouts = new Set(macroLayouts);
  const targetMin = Math.min(
    input.system.qaRules.minMacroLayoutsForTenSlides,
    input.resolvedSlides.length,
  );
  if (input.resolvedSlides.length >= 4 && distinctMacroLayouts.size < targetMin) {
    warnings.push(
      `visual_layout_diversity_low: ${distinctMacroLayouts.size} macro layout(s) used; target is ${targetMin}.`,
    );
  }

  if (input.system.qaRules.preventThreeConsecutiveMacroLayouts) {
    for (let index = 2; index < macroLayouts.length; index += 1) {
      if (
        macroLayouts[index] === macroLayouts[index - 1] &&
        macroLayouts[index] === macroLayouts[index - 2]
      ) {
        warnings.push(
          `visual_layout_repetition: slides ${index - 1}-${index + 1} reuse ${macroLayouts[index]}.`,
        );
      }
    }
  }

  for (const [index, slide] of input.source.slides.entries()) {
    const resolved = input.resolvedSlides[index];
    if (slide.kind === "image" && !resolved?.imageSlot) {
      warnings.push(`slide_${index + 1}_image_slot_missing`);
    }
  }

  if (input.system.family === "education") {
    const hasLearningLayout = input.resolvedSlides.some((slide) =>
      ["concept-map", "step-board", "practice", "summary"].includes(
        slide.macroLayout,
      ),
    );
    if (!hasLearningLayout) {
      warnings.push(
        "education_visual_rhythm_weak: use concept, step, practice, or summary layouts instead of plain bullets.",
      );
    }
  }

  if (input.system.family === "swiss") {
    if (input.system.tokens.cardRadius !== 0 || input.system.tokens.shadow !== "none") {
      warnings.push("swiss_visual_rule_violation: sharp no-shadow tokens required.");
    }
  }

  return warnings;
}

function visualDeckBlockingQaWarnings(warnings: string[]) {
  return warnings.filter((warning) =>
    /^(?:visual_blank_content_slide|visual_sparse_card_layout|visual_empty_render_block|visual_single_card_hole|visual_shape_layout_mismatch|visible_language_pollution|visual_cover_unrequested_decoration|visual_layout_repetition)/.test(
      warning,
    ),
  );
}

const englishPlanningFragmentPattern =
  /\b(?:opener|four-step|method|audience|narrative|slide|layout|speaker|talk track|content slot|proof object|takeaway)\b/i;

function hasLikelyEnglishPlanningFragment(value: string) {
  return /[\u4e00-\u9fff]/u.test(value) && englishPlanningFragmentPattern.test(value);
}

function slideVisibleTextFields(slide: SlideSpec) {
  return [
    slide.claim,
    slide.title,
    slide.kicker,
    slide.caption,
    slide.footer,
    ...bodyToBullets(slide.body),
  ].filter((item): item is string => typeof item === "string" && item.length > 0);
}

function verifyDeckLayout(input: {
  source: VisualDeckSourceLike;
  system: CompiledVisualSystem;
  resolvedSlides: ResolvedVisualSlide[];
}) {
  const warnings: string[] = [];
  for (const [index, slide] of input.source.slides.entries()) {
    const resolved = input.resolvedSlides[index];
    const bullets = bodyToBullets(slide.body);
    const textBody = textFromSlideBody(slide.body);
    const hasStructuredData =
      normalizeRows(slide.body).length > 0 ||
      normalizeChartData(slide.body).length > 0 ||
      normalizeComparisonGroups(slide).length > 0;
    const hasVisibleBody =
      bullets.length > 0 ||
      textBody.length > 0 ||
      hasStructuredData ||
      Boolean(slide.caption?.trim());

    if (
      resolved?.role === "content" &&
      !hasVisibleBody &&
      slide.kind !== "section"
    ) {
      warnings.push(`visual_blank_content_slide: slide_${index + 1}`);
    }
    if (
      resolved?.role === "content" &&
      (resolved.contentShape === "cards" || resolved.macroLayout === "cards") &&
      bullets.length === 0
    ) {
      warnings.push(`visual_empty_render_block: slide_${index + 1} has empty card layout.`);
    }
    if (
      resolved?.role === "content" &&
      resolved.contentShape === "cards" &&
      bullets.length === 1
    ) {
      warnings.push(`visual_single_card_hole: slide_${index + 1} has one card in a card grid.`);
    }
    if (
      resolved?.macroLayout === "concept-map" &&
      bullets.length < 3
    ) {
      warnings.push(
        `visual_sparse_card_layout: slide_${index + 1} uses concept-map with ${bullets.length} bullet(s).`,
      );
    }
    if (
      resolved?.macroLayout === "longform" &&
      resolved.contentShape === "cards"
    ) {
      warnings.push(
        `visual_shape_layout_mismatch: slide_${index + 1} maps cards into longform.`,
      );
    }
    if (
      input.source.design.resolvedLanguage === "zh" &&
      slideVisibleTextFields(slide).some(hasLikelyEnglishPlanningFragment)
    ) {
      warnings.push(`visible_language_pollution: slide_${index + 1}`);
    }
  }

  for (const scene of compileVisualScenes({
    source: input.source as DeckSource,
    system: input.system,
    resolvedSlides: input.resolvedSlides,
  }).scenes) {
    const authoredNodes =
      input.source.slides[scene.slideIndex]?.visualScene?.nodes ?? [];
    const authoredScene = Array.isArray(authoredNodes) && authoredNodes.length > 0;
    const decorativeNodes = scene.nodes.filter((node) =>
      node.kind === "diagram" || node.kind === "shape" || node.kind === "panel",
    );
    if (
      input.system.family === "education" &&
      !authoredScene &&
      input.system.illustration !== "handdrawn" &&
      decorativeNodes.length > 0
    ) {
      warnings.push(
        `visual_cover_unrequested_decoration: slide_${scene.slideIndex + 1}`,
      );
    }
  }

  return warnings;
}

function stripLanguagePollution(value: string) {
  if (!hasLikelyEnglishPlanningFragment(value)) {
    return value;
  }
  return value
    .replace(/\s*(?:不要|请勿|避免)?\s*(?:do not|don'?t|avoid|use|for|as|with|on)\b[^\u4e00-\u9fff。！？；，、]*$/i, "")
    .replace(/\s*(?:不要|请勿|避免)?\s*\b(?:opener|four-step|method|audience|narrative|slide|layout|speaker|content slot|proof object|takeaway)\b[^\u4e00-\u9fff。！？；，、]*$/i, "")
    .trim();
}

function repairSlideBody(body: unknown) {
  if (typeof body === "string") {
    return stripLanguagePollution(body);
  }
  if (Array.isArray(body)) {
    return body.map((item) =>
      typeof item === "string" ? stripLanguagePollution(item) : item,
    );
  }
  if (body && typeof body === "object") {
    const record = { ...(body as Record<string, unknown>) };
    if (typeof record.text === "string") {
      record.text = stripLanguagePollution(record.text);
    }
    if (Array.isArray(record.bullets)) {
      record.bullets = record.bullets.map((item) =>
        typeof item === "string" ? stripLanguagePollution(item) : item,
      );
    }
    if (Array.isArray(record.items)) {
      record.items = record.items.map((item) =>
        typeof item === "string" ? stripLanguagePollution(item) : item,
      );
    }
    return record;
  }
  return body;
}

function repairDeckSpec(deckSpec: DeckSpec): DeckSpec {
  const shouldStripLanguagePollution = deckSpec.design.resolvedLanguage === "zh";
  return {
    ...deckSpec,
    slides: deckSpec.slides.map((slide) => {
      const bullets = bodyToBullets(slide.body);
      const rows = normalizeRows(slide.body);
      const chartData = normalizeChartData(slide.body);
      const hasBody =
        bullets.length > 0 ||
        rows.length > 0 ||
        chartData.length > 0 ||
        Boolean(textFromSlideBody(slide.body));
      const repairedKind =
        slide.kind === "content" && !hasBody ? ("section" as const) : slide.kind;
      return {
        ...slide,
        kind: repairedKind,
        claim: shouldStripLanguagePollution
          ? stripLanguagePollution(slide.claim)
          : slide.claim,
        ...(slide.title
          ? {
              title: shouldStripLanguagePollution
                ? stripLanguagePollution(slide.title)
                : slide.title,
            }
          : {}),
        ...(slide.caption
          ? {
              caption: shouldStripLanguagePollution
                ? stripLanguagePollution(slide.caption)
                : slide.caption,
            }
          : {}),
        ...(slide.footer
          ? {
              footer: shouldStripLanguagePollution
                ? stripLanguagePollution(slide.footer)
                : slide.footer,
            }
          : {}),
        ...(slide.body !== undefined
          ? {
              body: shouldStripLanguagePollution
                ? repairSlideBody(slide.body)
                : slide.body,
            }
          : {}),
      };
    }),
  };
}

function buildVisualDeckBlockingQaWarnings(source: DeckSource) {
  const metadata = extractVisualDeckMetadata(source);
  return {
    blockingWarnings: visualDeckBlockingQaWarnings(metadata.qaWarnings),
    metadata,
  };
}

const visualSceneNodeKinds = new Set<VisualSceneNodeKind>([
  "text-slot",
  "panel",
  "shape",
  "media-slot",
  "diagram",
  "metric",
  "divider",
]);

function sceneTextForRole(input: {
  cover: DeckSpec["cover"];
  role: string;
  slide: SlideSpec;
}) {
  if (input.role === "kicker") {
    return input.cover.kicker ?? input.slide.kicker;
  }
  if (input.role === "title") {
    return input.cover.title;
  }
  if (input.role === "subtitle") {
    return input.cover.subtitle;
  }
  return undefined;
}

function visualSceneNode(node: VisualSceneNode): VisualSceneNode {
  return node;
}

function defaultCoverSceneNodes(input: {
  cover: DeckSpec["cover"];
  slide: SlideSpec;
  system: CompiledVisualSystem;
}): VisualSceneNode[] {
  const { cover, slide, system } = input;
  const textNodes = [
    visualSceneNode({
      emphasis: "accent",
      kind: "text-slot",
      position: "top",
      role: "kicker",
      text: cover.kicker ?? slide.kicker,
    }),
    visualSceneNode({
      emphasis: "primary",
      kind: "text-slot",
      position: "hero",
      role: "title",
      text: cover.title,
    }),
    visualSceneNode({
      emphasis: "secondary",
      kind: "text-slot",
      position: "bottom",
      role: "subtitle",
      text: cover.subtitle,
    }),
  ].filter(
    (node): node is VisualSceneNode =>
      typeof node.text === "string" && node.text.trim().length > 0,
  );

  if (system.family === "education") {
    if (
      system.illustration !== "handdrawn" &&
      system.illustration !== "diagrams"
    ) {
      return textNodes;
    }
    return [
      visualSceneNode({ emphasis: "muted", kind: "panel", position: "center", role: "notebook" }),
      ...textNodes,
      visualSceneNode({ emphasis: "accent", kind: "diagram", position: "right", role: "concept-path" }),
      visualSceneNode({ emphasis: "muted", kind: "shape", position: "accent", role: "paper-tabs" }),
    ];
  }
  if (system.family === "blueprint") {
    return [
      visualSceneNode({ emphasis: "muted", kind: "diagram", position: "right", role: "schematic-grid" }),
      ...textNodes,
      visualSceneNode({ emphasis: "accent", kind: "divider", position: "left", role: "measurement-rule" }),
      visualSceneNode({ emphasis: "muted", kind: "shape", position: "bottom", role: "coordinates" }),
    ];
  }
  if (system.family === "swiss") {
    return [
      visualSceneNode({ emphasis: "accent", kind: "metric", position: "left", role: "deck-number", text: "01" }),
      ...textNodes.map(
        (node): VisualSceneNode => ({
        ...node,
        position: node.role === "title" ? ("center" as const) : node.position,
        }),
      ),
      visualSceneNode({ emphasis: "muted", kind: "divider", position: "bottom", role: "axis-line" }),
    ];
  }
  if (system.family === "data-report") {
    return [
      visualSceneNode({
        emphasis: "accent",
        kind: "metric",
        position: "right",
        role: "kpi-mark",
        text: String(slide.claim.length || cover.title.length),
      }),
      ...textNodes,
      visualSceneNode({ emphasis: "muted", kind: "panel", position: "bottom", role: "report-strip" }),
      visualSceneNode({ emphasis: "muted", kind: "divider", position: "center", role: "ledger-rule" }),
    ];
  }
  return [
    visualSceneNode({ emphasis: "accent", kind: "media-slot", position: "right", role: "hero-media" }),
    ...textNodes,
    visualSceneNode({ emphasis: "muted", kind: "shape", position: "accent", role: "masthead-frame" }),
    visualSceneNode({ emphasis: "accent", kind: "divider", position: "top", role: "editorial-rule" }),
  ];
}

function compileAuthoredSceneNode(input: {
  cover: DeckSpec["cover"];
  node: unknown;
  slide: SlideSpec;
  warnings: string[];
}): VisualSceneNode | null {
  if (!input.node || typeof input.node !== "object" || Array.isArray(input.node)) {
    input.warnings.push("visual_scene_node_rejected: invalid_node");
    return null;
  }
  const record = input.node as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : undefined;
  if (!kind || !visualSceneNodeKinds.has(kind as VisualSceneNodeKind)) {
    input.warnings.push(`visual_scene_node_rejected: ${kind ?? "missing_kind"}`);
    return null;
  }
  const role =
    typeof record.role === "string" && record.role.trim()
      ? compactText(record.role, 80)
      : kind;
  const position =
    record.position === "hero" ||
    record.position === "left" ||
    record.position === "right" ||
    record.position === "top" ||
    record.position === "bottom" ||
    record.position === "center" ||
    record.position === "accent"
      ? record.position
      : "center";
  const emphasis =
    record.emphasis === "primary" ||
    record.emphasis === "secondary" ||
    record.emphasis === "accent" ||
    record.emphasis === "muted"
      ? record.emphasis
      : "secondary";
  const text =
    typeof record.text === "string" && record.text.trim()
      ? compactText(record.text, 400)
      : sceneTextForRole({ cover: input.cover, role, slide: input.slide });
  return {
    emphasis,
    kind: kind as VisualSceneNodeKind,
    position,
    role,
    ...(text ? { text } : {}),
    ...(typeof record.token === "string" ? { token: compactText(record.token, 80) } : {}),
    ...(typeof record.variant === "string" ? { variant: compactText(record.variant, 80) } : {}),
  };
}

function compileVisualScenes(input: {
  source: DeckSource;
  system: CompiledVisualSystem;
  resolvedSlides: ResolvedVisualSlide[];
}) {
  const scenes: CompiledVisualScene[] = [];
  const warnings: string[] = [];
  const cover = input.source.deckSpec.cover;
  for (const [index, slide] of input.source.slides.entries()) {
    const resolved = input.resolvedSlides[index];
    if (!resolved || resolved.role !== "cover") {
      continue;
    }
    const authoredNodes = Array.isArray(slide.visualScene?.nodes)
      ? slide.visualScene.nodes.slice(0, 12)
      : [];
    const nodeWarnings: string[] = [];
    const compiledNodes = authoredNodes
      .map((node) =>
        compileAuthoredSceneNode({
          cover,
          node,
          slide,
          warnings: nodeWarnings,
        }),
      )
      .filter((node): node is VisualSceneNode => node !== null);
    const treatment =
      normalizeVisualToken(slide.visualScene?.treatment) ??
      (input.system.family === "education" &&
      input.system.illustration !== "handdrawn" &&
      input.system.illustration !== "diagrams"
        ? "lesson-board"
        : input.system.coverTreatment);
    const nodes =
      compiledNodes.length > 0
        ? compiledNodes
        : defaultCoverSceneNodes({ cover, slide, system: input.system });
    warnings.push(
      ...nodeWarnings.map((warning) => `slide_${index + 1}_${warning}`),
    );
    scenes.push({
      family: input.system.family,
      layoutId: resolved.layoutId,
      nodes,
      sceneId: `visual-scene-${index + 1}`,
      slideIndex: index,
      treatment,
      warnings: nodeWarnings,
    });
  }
  return { scenes, warnings };
}

function visualFamilyFromPreset(source: VisualDeckSourceLike): VisualSystemFamily {
  if (source.design.stylePreset === "technical") {
    return "blueprint";
  }
  if (source.design.stylePreset === "editorial") {
    return "editorial";
  }
  if (source.design.stylePreset === "data-heavy") {
    return "data-report";
  }
  return "data-report";
}

function inferVisualSystemFamily(source: VisualDeckSourceLike): VisualSystemFamily {
  const explicit = source.design.visualSystem?.styleFamily;
  const designText = customDesignTextFor(source);
  const intentText = customDesignIntentTextFor(source);
  const hasEducationIntent = textMatchesEducationIntent(designText);
  const hasExplicitEditorialIntent =
    textExplicitlyRequestsEditorialFamily(intentText);
  if (
    source.design.stylePreset === "custom" &&
    hasEducationIntent &&
    !hasExplicitEditorialIntent &&
    (explicit === "editorial" || explicit === "magazine")
  ) {
    return "education";
  }
  if (explicit && explicit !== "auto") {
    return explicit === "editorial" ? "editorial" : explicit;
  }
  if (source.design.stylePreset !== "custom") {
    return visualFamilyFromPreset(source);
  }

  if (hasEducationIntent || /handdrawn|手绘/u.test(designText)) {
    return "education";
  }
  if (
    /blueprint|architecture|technical|system|schematic|diagram|工程|架构|系统|蓝图/u.test(
      designText,
    )
  ) {
    return "blueprint";
  }
  if (
    /swiss|helvetica|vignelli|ikb|international style|国际主义|瑞士|极简主义/u.test(
      designText,
    )
  ) {
    return "swiss";
  }
  if (
    /data|kpi|metric|dashboard|report|appendix|financial|表格|数据|指标|财务|报告/u.test(
      designText,
    )
  ) {
    return "data-report";
  }
  if (
    /magazine|editorial|monocle|journal|story|narrative|print|杂志|编辑|叙事|刊物/u.test(
      designText,
    )
  ) {
    return "magazine";
  }
  return "education";
}

function inferVisualSystemDensity(source: VisualDeckSourceLike): VisualSystemDensity {
  const explicit = source.design.visualSystem?.density;
  if (explicit) {
    return explicit;
  }
  const designText = customDesignTextFor(source);
  if (/dense|compact|dashboard|appendix|密集|紧凑|高密度/u.test(designText)) {
    return "dense";
  }
  if (/airy|spacious|quiet|white space|gallery|留白|呼吸|空旷/u.test(designText)) {
    return "airy";
  }
  return "balanced";
}

function inferVisualSystemGeometry(
  source: VisualDeckSourceLike,
  family: VisualSystemFamily,
): VisualSystemGeometry {
  const explicit = source.design.visualSystem?.geometry;
  if (explicit) {
    return explicit;
  }
  const designText = customDesignTextFor(source);
  if (family === "swiss" || family === "blueprint") {
    return "sharp";
  }
  if (/soft|warm|round|handdrawn|柔和|温暖|圆角|手绘/u.test(designText)) {
    return "soft";
  }
  if (family === "magazine" || family === "editorial") {
    return "editorial";
  }
  if (/technical|schematic|直角|硬朗/u.test(designText)) {
    return "technical";
  }
  return "soft";
}

function inferVisualSystemChrome(
  source: VisualDeckSourceLike,
  family: VisualSystemFamily,
): VisualSystemChrome {
  const explicit = source.design.visualSystem?.chrome;
  if (explicit) {
    return explicit;
  }
  if (family === "education") {
    return "lecture";
  }
  if (family === "magazine" || family === "editorial") {
    return "magazine";
  }
  if (family === "data-report") {
    return "report";
  }
  return "minimal";
}

function inferVisualSystemIllustration(
  source: VisualDeckSourceLike,
  family: VisualSystemFamily,
): VisualSystemIllustration {
  const explicit = source.design.visualSystem?.illustration;
  if (explicit) {
    return explicit;
  }
  const designText = customDesignTextFor(source);
  if (/handdrawn|sketch|doodle|手绘|草图/u.test(designText)) {
    return "handdrawn";
  }
  if (/photo|image|screenshot|visual|图片|照片|截图/u.test(designText)) {
    return "image-led";
  }
  if (family === "blueprint") {
    return "diagrams";
  }
  if (family === "education" && customDesignRequestsDecorativeEducation(source)) {
    return "diagrams";
  }
  if (family === "data-report") {
    return "icons";
  }
  return "none";
}

function normalizeVisualToken(value: string | undefined, maxLength = 80) {
  const text = value?.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  return text ? text.slice(0, maxLength).replace(/^-+|-+$/g, "") : undefined;
}

function inferVisualCompositionStyle(
  source: VisualDeckSourceLike,
  family: VisualSystemFamily,
): VisualCompositionStyle {
  const explicit = source.design.visualSystem?.compositionStyle;
  if (explicit && explicit !== "auto") {
    return explicit;
  }
  if (family === "education") {
    return "notebook";
  }
  if (family === "blueprint") {
    return "schematic";
  }
  if (family === "data-report") {
    return "report";
  }
  if (family === "swiss") {
    return "axis";
  }
  if (family === "magazine" || family === "editorial") {
    return "poster";
  }
  return "split";
}

function inferVisualBackgroundTreatment(
  source: VisualDeckSourceLike,
  family: VisualSystemFamily,
): VisualBackgroundTreatment {
  const explicit = source.design.visualSystem?.backgroundTreatment;
  if (explicit && explicit !== "auto") {
    return explicit;
  }
  const designText = customDesignTextFor(source);
  if (/paper|notebook|warm|classroom|纸|课堂|笔记/u.test(designText)) {
    return "paper";
  }
  if (family === "blueprint" || family === "swiss") {
    return "grid";
  }
  if (family === "data-report") {
    return "plain";
  }
  if (family === "magazine" || family === "editorial") {
    return "image";
  }
  return "diagram";
}

const coverTreatmentsByFamily: Record<VisualSystemFamily, readonly string[]> = {
  swiss: ["axis-grid", "poster-number", "left-rule"],
  magazine: ["masthead", "image-led", "pullquote-cover"],
  education: ["lesson-board", "notebook-map", "practice-card"],
  blueprint: ["schematic-title", "system-map-cover", "spec-sheet"],
  "data-report": ["kpi-cover", "report-ledger", "executive-brief"],
  editorial: ["masthead", "image-led", "essay-cover"],
};

function inferCoverTreatment(
  source: VisualDeckSourceLike,
  family: VisualSystemFamily,
  compositionStyle: VisualCompositionStyle,
): string {
  const explicit = normalizeVisualToken(source.design.visualSystem?.coverTreatment);
  const allowed = coverTreatmentsByFamily[family];
  if (explicit && allowed.includes(explicit)) {
    return explicit;
  }
  if (explicit) {
    const matched = allowed.find((item) => item.includes(explicit) || explicit.includes(item));
    if (matched) {
      return matched;
    }
  }
  if (family === "education") {
    if (
      compositionStyle === "notebook" &&
      customDesignRequestsDecorativeEducation(source)
    ) {
      return "notebook-map";
    }
    return "lesson-board";
  }
  if (compositionStyle === "schematic" && family === "blueprint") {
    return "schematic-title";
  }
  if (compositionStyle === "report" && family === "data-report") {
    return "kpi-cover";
  }
  return (
    allowed[hashText(customDesignTextFor(source) || source.title) % allowed.length] ??
    allowed[0] ??
    "axis-grid"
  );
}

function themeForFamily(source: VisualDeckSourceLike, family: VisualSystemFamily) {
  if (source.design.stylePreset === "custom") {
    const customTheme = buildCustomTheme(source);
    if (family === "swiss") {
      return {
        ...customTheme,
        background: customTheme.background,
        card: "FFFFFF",
        grid: mixHex(customTheme.text, customTheme.background, 0.86),
        sectionBackground: customTheme.accent,
        sectionText: relativeLuminance(customTheme.accent) > 0.48 ? customTheme.text : "FFFFFF",
      };
    }
    if (family === "education") {
      return {
        ...customTheme,
        background: mixHex(customTheme.background, "FFFDF7", 0.62),
        card: mixHex(customTheme.background, "FFFFFF", 0.78),
        grid: mixHex(customTheme.text, customTheme.background, 0.86),
      };
    }
    return customTheme;
  }
  return deckThemes[source.design.stylePreset] ?? deckThemes.custom;
}

function compileVisualSystem(source: VisualDeckSourceLike): CompiledVisualSystem {
  const family = inferVisualSystemFamily(source);
  const density = inferVisualSystemDensity(source);
  const geometry = inferVisualSystemGeometry(source, family);
  const chrome = inferVisualSystemChrome(source, family);
  const illustration = inferVisualSystemIllustration(source, family);
  const compositionStyle = inferVisualCompositionStyle(source, family);
  const backgroundTreatment = inferVisualBackgroundTreatment(source, family);
  const coverTreatment = inferCoverTreatment(source, family, compositionStyle);
  const designText = customDesignTextFor(source);
  const layoutPolicy = {
    strict: source.design.visualSystem?.layoutPolicy?.strict ?? family === "swiss",
    diversity: source.design.visualSystem?.layoutPolicy?.diversity ?? "normal",
  } satisfies CompiledVisualSystem["layoutPolicy"];
  const theme = themeForFamily(source, family);
  const legacyTokens = visualThemeTokensForLegacy(source, family, geometry, density);
  const motionPreset: CompiledVisualSystem["motion"]["preset"] =
    family === "blueprint"
      ? "technical"
      : family === "magazine" || family === "editorial"
        ? "editorial"
        : /kinetic|bold|poster|motion|动效|冲击/u.test(designText)
          ? "kinetic"
          : "calm";

  return {
    version: 3,
    backgroundTreatment,
    compositionStyle,
    coverTreatment,
    family,
    density,
    geometry,
    chrome,
    illustration,
    layoutPolicy,
    motion: { preset: motionPreset },
    assetPolicy: {
      imageSlots: illustration === "image-led",
      illustration,
      motifs: source.design.visualSystem?.motifs ?? [],
    },
    qaRules: {
      minMacroLayoutsForTenSlides:
        layoutPolicy.diversity === "high" || family === "swiss" ? 4 : 3,
      preventThreeConsecutiveMacroLayouts: true,
      requireRegisteredLayouts: true,
    },
    theme,
    tokens: legacyTokens,
  };
}

function visualLayoutFor(source: VisualDeckSourceLike): VisualLayoutStyle {
  if (source.design.stylePreset === "technical") {
    return "blueprint";
  }
  if (source.design.stylePreset === "editorial") {
    return "editorial";
  }
  if (source.design.stylePreset === "data-heavy") {
    return "minimal";
  }
  if (source.design.stylePreset !== "custom") {
    return "bento";
  }

  const designText = customDesignTextFor(source);
  if (
    /blueprint|technical|architecture|system|schematic|diagram|grid|工程|架构|系统|蓝图|网格/u.test(
      designText,
    )
  ) {
    return "blueprint";
  }
  if (/poster|statement|bold|dramatic|campaign|hero|海报|冲击|大字|大胆/u.test(designText)) {
    return "poster";
  }
  if (/editorial|magazine|narrative|story|book|print|literary|杂志|编辑|叙事|书/u.test(designText)) {
    return "editorial";
  }
  if (/minimal|quiet|calm|sparse|clean|white space|克制|极简|留白|干净/u.test(designText)) {
    return "minimal";
  }
  return "bento";
}

function visualThemeTokensForLegacy(
  source: VisualDeckSourceLike,
  family: VisualSystemFamily = inferVisualSystemFamily(source),
  geometry: VisualSystemGeometry = inferVisualSystemGeometry(source, family),
  density: VisualSystemDensity = inferVisualSystemDensity(source),
): VisualThemeTokens {
  const layout = visualLayoutFor(source);
  const designText =
    source.design.stylePreset === "custom" ? customDesignTextFor(source) : "";
  const wantsSharp =
    geometry === "sharp" ||
    geometry === "technical" ||
    layout === "blueprint" ||
    /sharp|brutalist|technical|grid|schematic|直角|硬朗/u.test(designText);
  const wantsSoft =
    geometry === "soft" ||
    /soft|diffuse|gallery|paper|ceramic|round|柔和|圆角|纸/u.test(designText);
  const wantsFlat =
    family === "swiss" ||
    layout === "minimal" ||
    /flat|no shadow|print|minimal|quiet|无阴影|平面|克制/u.test(designText);
  const cardRadius = wantsSharp
    ? family === "swiss"
      ? 0
      : 2
    : wantsSoft
      ? 22
      : layout === "editorial"
        ? 18
        : layout === "poster"
          ? 0
          : 10;
  const shadow = wantsFlat
    ? "none"
    : wantsSharp
      ? "10px 14px 0 rgba(8, 12, 18, .16)"
      : "0 28px 68px rgba(8, 12, 18, .12)";
  const patternOpacity =
    family === "swiss"
      ? 0.1
      : layout === "blueprint"
      ? 0.34
      : layout === "minimal"
        ? 0.08
        : layout === "poster"
          ? 0.18
          : 0.2;
  const titleScale =
    layout === "poster"
      ? 1.16
      : layout === "minimal"
        ? 0.9
        : layout === "editorial"
          ? 1.04
          : density === "airy"
            ? 1.04
            : density === "dense"
              ? 0.92
              : 1;

  return {
    cardRadius,
    layout,
    patternOpacity,
    shadow,
    titleScale,
  };
}

function visualThemeTokensFor(source: DeckSource): VisualThemeTokens {
  return compileVisualSystem(source).tokens;
}

function inferDeckLanguage(input: {
  brief?: string;
  language?: PptxLanguage;
  slides?: AuthoredSlideSpec[];
  title: string;
}): ResolvedPptxLanguage {
  if (input.language === "zh" || input.language === "en") {
    return input.language;
  }

  const sample = [
    input.title,
    input.brief ?? "",
    ...(input.slides ?? []).flatMap((slide) => [
      slide.claim ?? "",
      slide.title ?? "",
      typeof slide.body === "string" ? slide.body : "",
      typeof slide.notes === "string" ? slide.notes : "",
    ]),
  ].join("\n");

  return /[\u3400-\u9fff]/.test(sample) ? "zh" : "en";
}

function sanitizeFileName(value: string) {
  return sanitizeArtifactDownloadFileBaseName(value, "generated-presentation");
}

function buildPptxArtifactUrl(input: {
  artifactId: string;
  workspaceId: string;
}) {
  const params = new URLSearchParams({
    artifactId: input.artifactId,
    workspaceId: input.workspaceId,
  });
  return `/artifact-preview?${params.toString()}`;
}

function buildSourceJsonArtifactUrl(input: {
  artifactId: string;
  workspaceId: string;
}) {
  return `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/artifacts/${encodeURIComponent(input.artifactId)}/source.json`;
}

function resolveToolRuntimeCallId(runtime: ToolRuntime) {
  const runtimeRecord = runtime as ToolRuntime & {
    config?: { toolCall?: { id?: unknown } };
    toolCall?: { id?: unknown };
    toolCallId?: unknown;
  };
  const candidate =
    runtimeRecord.toolCallId ??
    runtimeRecord.toolCall?.id ??
    runtimeRecord.config?.toolCall?.id;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

function bodyToBullets(body: unknown): string[] {
  if (Array.isArray(body)) {
    return body
      .map((item) => {
        if (typeof item === "string") {
          return item.trim();
        }
        if (item && typeof item === "object" && "text" in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === "string" ? text.trim() : "";
        }
        return "";
      })
      .filter((item) => item.length > 0)
      .slice(0, 8);
  }

  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (Array.isArray(record.bullets)) {
      return bodyToBullets(record.bullets);
    }
    if (Array.isArray(record.items)) {
      return bodyToBullets(record.items);
    }
    if (typeof record.text === "string") {
      return splitTextBody(record.text);
    }
  }

  if (typeof body === "string") {
    return splitTextBody(body);
  }

  return [];
}

function splitTextBody(value: string) {
  return value
    .split(/\n+|(?:^|\s)[-*]\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function isSlideKind(value: string): value is AuthoredSlideSpec["kind"] {
  return slideKinds.includes(value as AuthoredSlideSpec["kind"]);
}

function cleanLeakedJsonText(value: string, maxLength: number) {
  const text = value
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .trim();
  return sanitizeToolTextInput(text, maxLength, {
    repairJsonLeakage: true,
  }) as string;
}

function readLeakedSlideStringField(chunk: string, field: string) {
  const fieldPattern = new RegExp(
    `(?:\\\\?["'])${field}(?:\\\\?["'])\\s*:\\s*(?:\\\\?["'])`,
    "i",
  );
  const match = fieldPattern.exec(chunk);
  if (!match) {
    return undefined;
  }

  const start = match.index + match[0].length;
  const rest = chunk.slice(start);
  const delimiter = rest.search(
    /(?:\\?["'])\s*,\s*\\?["'](?:body|caption|claim|footer|intent|kicker|kind|layout|layoutHint|notes|title)\\?["']\s*:|(?:\\?["'])\s*}\s*,?\s*$/s,
  );
  const raw = delimiter >= 0 ? rest.slice(0, delimiter) : rest;
  return cleanLeakedJsonText(raw, field === "notes" ? 2000 : 500);
}

function readLeakedSlideLayout(chunk: string): AuthoredSlideSpec["layout"] {
  const emphasis = chunk.match(
    /(?:\\?["'])layout(?:\\?["'])\s*:\s*\{[\s\S]*?(?:\\?["'])emphasis(?:\\?["'])\s*:\s*(?:\\?["'])(text|image|data|quote|process)(?:\\?["'])/i,
  )?.[1];
  const pattern = readLeakedSlideStringField(chunk, "pattern");
  if (!emphasis && !pattern) {
    return undefined;
  }
  return {
    ...(pattern ? { pattern: cleanLeakedJsonText(pattern, 120) } : {}),
    ...(emphasis ? { emphasis: emphasis as NonNullable<AuthoredSlideSpec["layout"]>["emphasis"] } : {}),
  };
}

function splitLeakedSlideChunks(value: string) {
  const starts = Array.from(
    value.matchAll(/\{\s*\\?["']kind\\?["']\s*:/g),
    (match) => match.index ?? 0,
  );
  return starts
    .map((start, index) => {
      const end = starts[index + 1] ?? value.length;
      return value
        .slice(start, end)
        .replace(/\]\s*,\s*\\?["']slides\\?["'][\s\S]*$/i, "")
        .replace(/,\s*$/g, "")
        .trim();
    })
    .filter(Boolean);
}

function parseLeakedSlideChunk(chunk: string): AuthoredSlideSpec | null {
  const kind = readLeakedSlideStringField(chunk, "kind");
  if (!kind || !isSlideKind(kind)) {
    return null;
  }

  const claim = readLeakedSlideStringField(chunk, "claim");
  const title = readLeakedSlideStringField(chunk, "title");
  const kicker = readLeakedSlideStringField(chunk, "kicker");
  const caption = readLeakedSlideStringField(chunk, "caption");
  const footer = readLeakedSlideStringField(chunk, "footer");
  const intent = readLeakedSlideStringField(chunk, "intent");
  const body = readLeakedSlideStringField(chunk, "body");
  const notes = readLeakedSlideStringField(chunk, "notes");
  const layout = readLeakedSlideLayout(chunk);
  return {
    kind,
    ...(claim ? { claim: cleanLeakedJsonText(claim, 240) } : {}),
    ...(title ? { title: cleanLeakedJsonText(title, 240) } : {}),
    ...(kicker ? { kicker: cleanLeakedJsonText(kicker, 160) } : {}),
    ...(caption ? { caption: cleanLeakedJsonText(caption, 500) } : {}),
    ...(footer ? { footer: cleanLeakedJsonText(footer, 240) } : {}),
    ...(intent ? { intent: cleanLeakedJsonText(intent, 500) } : {}),
    ...(body ? { body: cleanLeakedJsonText(body, 4000) } : {}),
    ...(notes ? { notes: cleanLeakedJsonText(notes, 2000) } : {}),
    ...(layout ? { layout } : {}),
  };
}

function repairLeakedSlideJsonInSlides(slides: AuthoredSlideSpec[]) {
  const repaired: AuthoredSlideSpec[] = [];
  for (const slide of slides) {
    if (typeof slide.body !== "string") {
      repaired.push(slide);
      continue;
    }

    const leakIndex = slide.body.search(
      /(?:\\?["'])\s*}\s*,\s*\{\s*\\?["']kind\\?["']\s*:/,
    );
    if (leakIndex < 0) {
      repaired.push(slide);
      continue;
    }

    const leakedStart = slide.body.indexOf("{", leakIndex);
    const leakedSlides =
      leakedStart >= 0
        ? splitLeakedSlideChunks(slide.body.slice(leakedStart))
            .map(parseLeakedSlideChunk)
            .filter((item): item is AuthoredSlideSpec => item !== null)
        : [];
    const leadingBody = cleanLeakedJsonText(slide.body.slice(0, leakIndex), 4000);
    const { body: _body, ...slideWithoutBody } = slide;
    repaired.push(
      leadingBody
        ? {
            ...slide,
            body: leadingBody,
          }
        : slideWithoutBody,
    );
    repaired.push(...leakedSlides);
  }

  return repaired.slice(0, 40);
}

function normalizeRows(body: unknown): string[][] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return [];
  }
  const record = body as Record<string, unknown>;
  const rows = Array.isArray(record.rows) ? record.rows : [];
  return rows
    .map((row) =>
      Array.isArray(row)
        ? row.map((cell) => String(cell ?? "").slice(0, 80))
        : [],
    )
    .filter((row) => row.length > 0)
    .slice(0, 8);
}

function normalizeRowsForHtml(body: unknown): string[][] {
  return normalizeRows(body);
}

function normalizeChartData(
  body: unknown,
): Array<{ name: string; value: number }> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return [];
  }
  const record = body as Record<string, unknown>;
  const data = Array.isArray(record.data) ? record.data : [];
  return data
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const row = item as Record<string, unknown>;
      const name = typeof row.name === "string" ? row.name.trim() : "";
      const value =
        typeof row.value === "number" && Number.isFinite(row.value)
          ? row.value
          : null;
      return name && value !== null ? { name, value } : null;
    })
    .filter((item): item is { name: string; value: number } => item !== null)
    .slice(0, 8);
}

function readUInt16(buffer: Buffer, offset: number) {
  return offset >= 0 && offset + 2 <= buffer.length
    ? buffer.readUInt16LE(offset)
    : 0;
}

function readUInt32(buffer: Buffer, offset: number) {
  return offset >= 0 && offset + 4 <= buffer.length
    ? buffer.readUInt32LE(offset)
    : 0;
}

function extractZipEntries(buffer: Buffer) {
  const endSignature = 0x06054b50;
  let endOffset = -1;
  const minEndOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minEndOffset; offset -= 1) {
    if (readUInt32(buffer, offset) === endSignature) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) {
    return [];
  }

  const entryCount = readUInt16(buffer, endOffset + 10);
  const centralDirectoryOffset = readUInt32(buffer, endOffset + 16);
  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32(buffer, offset) !== 0x02014b50) {
      break;
    }
    const compressionMethod = readUInt16(buffer, offset + 10);
    const compressedSize = readUInt32(buffer, offset + 20);
    const uncompressedSize = readUInt32(buffer, offset + 24);
    const fileNameLength = readUInt16(buffer, offset + 28);
    const extraLength = readUInt16(buffer, offset + 30);
    const commentLength = readUInt16(buffer, offset + 32);
    const localHeaderOffset = readUInt32(buffer, offset + 42);
    const name = buffer
      .subarray(offset + 46, offset + 46 + fileNameLength)
      .toString("utf8");
    entries.push({
      compressionMethod,
      compressedSize,
      localHeaderOffset,
      name,
      uncompressedSize,
    });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(buffer: Buffer, entry: ZipEntry) {
  const offset = entry.localHeaderOffset;
  if (readUInt32(buffer, offset) !== 0x04034b50) {
    return null;
  }
  const fileNameLength = readUInt16(buffer, offset + 26);
  const extraLength = readUInt16(buffer, offset + 28);
  const dataOffset = offset + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(
    dataOffset,
    dataOffset + entry.compressedSize,
  );
  if (entry.compressionMethod === 0) {
    return compressed;
  }
  if (entry.compressionMethod === 8) {
    return inflateRawSync(compressed);
  }
  return null;
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function isAllowedEmptyPptxObjectName(name: string) {
  return /^sw:chrome:/i.test(name) || /^sw:content:chart$/i.test(name);
}

function extractSlideNumberFromPath(path: string) {
  const match = path.match(/slide(\d+)\.xml$/);
  return match?.[1] ? Number(match[1]) : 0;
}

function extractPptxSlideXml(buffer: Buffer) {
  return extractZipEntries(buffer)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    .sort(
      (left, right) =>
        extractSlideNumberFromPath(left.name) -
        extractSlideNumberFromPath(right.name),
    )
    .map((entry) => ({
      path: entry.name,
      xml: readZipEntry(buffer, entry)?.toString("utf8") ?? "",
    }))
    .filter((entry) => entry.xml.length > 0);
}

function extractPptxShapeFragments(slideXml: string) {
  const fragments: string[] = [];
  const pattern = /<p:sp\b[\s\S]*?<\/p:sp>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(slideXml))) {
    fragments.push(match[0]);
  }
  return fragments;
}

function extractPptxShapeName(fragment: string) {
  const match = fragment.match(/<p:cNvPr\b[^>]*\bname="([^"]*)"/);
  return match?.[1] ? decodeXmlEntities(match[1]) : "";
}

function extractPptxShapeText(fragment: string) {
  const matches = Array.from(
    fragment.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g),
  );
  return matches
    .map((match) => decodeXmlEntities(match[1] ?? ""))
    .join("")
    .trim();
}

function extractPptxShapeGeometry(fragment: string) {
  const off = fragment.match(/<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/);
  const ext = fragment.match(/<a:ext\b[^>]*\bcx="(-?\d+)"[^>]*\bcy="(-?\d+)"/);
  const prst = fragment.match(/<a:prstGeom\b[^>]*\bprst="([^"]*)"/);
  if (!off?.[1] || !off[2] || !ext?.[1] || !ext[2]) {
    return null;
  }
  return {
    x: Number(off[1]),
    y: Number(off[2]),
    cx: Number(ext[1]),
    cy: Number(ext[2]),
    prst: prst?.[1] ?? "",
  };
}

function hasVisibleEmptyShapeStyling(fragment: string) {
  const hasFill = /<a:(?:solidFill|gradFill|pattFill)\b/.test(fragment);
  const line = fragment.match(/<a:ln\b[\s\S]*?<\/a:ln>/);
  const hasVisibleLine = Boolean(line && !/<a:noFill\b/.test(line[0]));
  return hasFill || hasVisibleLine;
}

function inspectEditableNativePptx(buffer: Buffer) {
  const warnings: string[] = [];
  const repeated = new Map<string, Set<number>>();
  const emuPerInch = 914400;
  const repeatedPrecision = 9144;
  for (const { path, xml } of extractPptxSlideXml(buffer)) {
    const slideNumber = extractSlideNumberFromPath(path);
    for (const fragment of extractPptxShapeFragments(xml)) {
      const name = extractPptxShapeName(fragment);
      const text = extractPptxShapeText(fragment);
      const hasPlaceholder = /<p:ph\b/.test(fragment);
      const geometry = extractPptxShapeGeometry(fragment);
      const hasVisibleEmptyStyle = hasVisibleEmptyShapeStyling(fragment);
      if (hasPlaceholder && !text) {
        warnings.push(
          `editable_native_empty_placeholder: slide_${slideNumber} ${name || "unnamed"}`,
        );
      }
      if (
        geometry &&
        !text &&
        hasVisibleEmptyStyle &&
        !isAllowedEmptyPptxObjectName(name)
      ) {
        const areaInches =
          Math.abs(geometry.cx / emuPerInch) *
          Math.abs(geometry.cy / emuPerInch);
        if (areaInches >= 0.02) {
          warnings.push(
            `editable_native_empty_shape: slide_${slideNumber} ${name || "unnamed"}`,
          );
          const signature = [
            Math.round(geometry.x / repeatedPrecision),
            Math.round(geometry.y / repeatedPrecision),
            Math.round(geometry.cx / repeatedPrecision),
            Math.round(geometry.cy / repeatedPrecision),
            geometry.prst,
          ].join(":");
          const slides = repeated.get(signature) ?? new Set<number>();
          slides.add(slideNumber);
          repeated.set(signature, slides);
        }
      }
    }
  }
  for (const slides of repeated.values()) {
    if (slides.size >= 3) {
      warnings.push(
        `editable_native_repeated_empty_geometry: slides_${Array.from(slides).join("_")}`,
      );
    }
  }
  return warnings;
}

function extractVisualDeckMetadata(source: DeckSource) {
  const system = compileVisualSystem(source);
  const resolved = resolveVisualSlides(source, system);
  const compiledScenes = compileVisualScenes({
    source,
    system,
    resolvedSlides: resolved.resolvedSlides,
  });
  const qaWarnings = [
    ...resolved.warnings,
    ...compiledScenes.warnings,
    ...validateVisualDeckSource({
      source,
      system,
      resolvedSlides: resolved.resolvedSlides,
    }),
    ...verifyDeckLayout({
      source,
      system,
      resolvedSlides: resolved.resolvedSlides,
    }),
  ];
  return {
    visualSystemVersion: system.version,
    compiledVisualSystem: system,
    resolvedLayouts: resolved.resolvedSlides,
    compiledVisualScenes: compiledScenes.scenes,
    coverTreatment: system.coverTreatment,
    sceneWarnings: compiledScenes.warnings,
    qaWarnings,
  };
}

function slideHasAuthoredContent(slide: AuthoredSlideSpec) {
  return Boolean(
    slide.claim?.trim() ||
      slide.title?.trim() ||
      slide.intent?.trim() ||
      slide.notes?.trim() ||
      slide.caption?.trim() ||
      slide.kicker?.trim() ||
      slide.footer?.trim() ||
      bodyToBullets(slide.body).length > 0 ||
      normalizeRows(slide.body).length > 0 ||
      normalizeChartData(slide.body).length > 0,
  );
}

function slideHasAuthoredDetail(slide: AuthoredSlideSpec) {
  return Boolean(
    slide.caption?.trim() ||
      bodyToBullets(slide.body).length > 0 ||
      normalizeRows(slide.body).length > 0 ||
      normalizeChartData(slide.body).length > 0,
  );
}

function hasSufficientAuthoredDeckContent(input: GeneratePptxArgs) {
  const authoredSlides = input.slides?.filter(slideHasAuthoredContent) ?? [];
  if (authoredSlides.length >= 2 && authoredSlides.some(slideHasAuthoredDetail)) {
    return true;
  }

  const briefLines = input.brief ? splitTextBody(input.brief) : [];
  return briefLines.length >= 2;
}

function fallbackSlides(input: GeneratePptxArgs): SlideSpec[] {
  const brief = input.brief?.trim();
  const bullets = brief ? splitTextBody(brief) : [];
  const titleKind: SlideSpec["kind"] = "title";
  return [
    {
      kind: titleKind,
      claim: input.title,
      ...(brief ? { body: compactText(brief, 220) } : {}),
    },
    ...(bullets.length > 0
      ? [
          {
            kind: "content" as const,
            claim: bullets[0] ?? input.title,
            body: bullets.slice(1),
          },
        ]
      : []),
  ];
}

function fallbackClaimForSlide(input: { slide: AuthoredSlideSpec; title: string }) {
  const title = input.slide.title?.trim();
  if (title) {
    return title;
  }
  if (input.slide.kind === "title") {
    return input.title;
  }
  return input.title;
}

function normalizeSlideClaims(input: {
  slides: AuthoredSlideSpec[];
  title: string;
}) {
  const warnings: string[] = [];
  const slides = input.slides.map((slide, index) => {
    const claim = slide.claim?.trim() ?? "";
    if (claim) {
      return { ...slide, claim };
    }
    warnings.push(`slide_${index + 1}_claim_missing_normalized`);
    return {
      ...slide,
      claim: fallbackClaimForSlide({
        slide,
        title: input.title,
      }),
    };
  });
  return { slides, warnings };
}

function normalizePptxGenerationRoute(input: {
  defaultGenerationMode?: GeneratePptxArgs["generationMode"];
  generationMode?: GeneratePptxArgs["generationMode"];
}): {
  artifactGenerationMode: GenerationMode;
  internalGenerationMode: InternalPptxGenerationMode;
  legacyGenerationMode: GenerationMode;
  normalizedFromLegacyMode: boolean;
  requestedGenerationMode?: GenerationMode;
  warnings: string[];
} {
  const requestedGenerationMode = input.generationMode ?? input.defaultGenerationMode;
  const legacyGenerationMode = requestedGenerationMode ?? "editable_native";
  const warnings =
    requestedGenerationMode === "visual_html"
      ? [
          "legacy_generation_mode_normalized: visual_html is accepted for compatibility and routed to high_quality_editable_pptx.",
        ]
      : [];

  return {
    artifactGenerationMode: "editable_native" as const,
    internalGenerationMode: INTERNAL_PPTX_GENERATION_MODE,
    legacyGenerationMode,
    normalizedFromLegacyMode:
      requestedGenerationMode !== undefined || input.defaultGenerationMode !== undefined,
    requestedGenerationMode,
    warnings,
  };
}

function normalizeDeckSpec(input: GeneratePptxArgs): DeckSpec {
  const declaredLanguage = input.design?.language ?? "auto";
  const resolvedLanguage = inferDeckLanguage({
    brief: input.brief,
    language: declaredLanguage,
    slides: input.slides,
    title: input.title,
  });
  const rawSlides =
    input.slides && input.slides.length > 0
      ? input.slides
      : fallbackSlides(input);
  const normalized = normalizeSlideClaims({
    slides: rawSlides,
    title: input.title,
  });
  const deckSpec: DeckSpec = {
    cover: {
      title: input.content?.cover?.title ?? input.title,
      ...(input.content?.cover?.subtitle
        ? { subtitle: input.content.cover.subtitle }
        : {}),
      ...(input.content?.cover?.kicker
        ? { kicker: input.content.cover.kicker }
        : {}),
    },
    design: {
      language: declaredLanguage,
      aspectRatio: input.design?.aspectRatio ?? "16:9",
      stylePreset: input.design?.stylePreset ?? "custom",
      resolvedLanguage,
      ...(input.design?.customBrief
        ? { customBrief: input.design.customBrief }
        : {}),
      ...(input.design?.visualSystem
        ? { visualSystem: input.design.visualSystem }
        : {}),
    },
    narrativeArc: input.content?.narrativeArc ?? [],
    normalizationWarnings: normalized.warnings,
    slides: normalized.slides,
    template: {
      usage: input.template?.usage ?? (input.templateArtifactId ? "visual_reference" : "none"),
    },
  };
  return repairDeckSpec(deckSpec);
}

function normalizeDeckSource(input: GeneratePptxArgs) {
  const deckSpec = normalizeDeckSpec(input);
  return {
    schemaVersion: 1,
    title: deckSpec.cover.title,
    mode: input.mode,
    brief: input.brief,
    deckSpec,
    design: deckSpec.design,
    assets: input.assets ?? {},
    output: {
      includeSourceJson: input.output?.includeSourceJson ?? false,
    },
    rendering: {
      preferHtmlTables: input.rendering?.preferHtmlTables ?? true,
    },
    templateArtifactId: input.templateArtifactId,
    template: deckSpec.template,
    sourceArtifactIds: input.sourceArtifactIds ?? [],
    normalizationWarnings: deckSpec.normalizationWarnings,
    slides: deckSpec.slides,
  };
}

function buildQaWarnings(input: {
  generationMode?: GenerationMode;
  source: DeckSource;
  output: GeneratePptxArgs["output"];
}) {
  const warnings: string[] = [];
  if (input.source.mode !== "create") {
    warnings.push(
      "mode_edit_analyze_v1_limited: v1 generates a new slides artifact and does not perform pixel-level OOXML template edits.",
    );
  }
  if (input.source.templateArtifactId) {
    warnings.push(
      "template_v1_limited: template inventory and deep master/layout preservation are planned for v2.",
    );
  }
  warnings.push(...input.source.normalizationWarnings);
  if (
    input.generationMode === "editable_native" &&
    input.source.rendering.preferHtmlTables
  ) {
    const hasLargeTable = input.source.slides.some(
      (slide) => slide.kind === "table" && normalizeRows(slide.body).length > 6,
    );
    if (hasLargeTable) {
      warnings.push(
        "html_table_rendering: table slides may use PptxGenJS tableToSlides for styled, auto-paged editable tables.",
      );
    }
  }
  if (
    input.generationMode === "editable_native" &&
    input.source.design.stylePreset === "custom"
  ) {
    warnings.push(
      "custom_visual_system_native_limited: custom visual system v3 is normalized to the native editable PPTX renderer.",
    );
  }
  if (input.generationMode !== "editable_native") {
    warnings.push(...extractVisualDeckMetadata(input.source).qaWarnings);
  }
  for (const [index, slide] of input.source.slides.entries()) {
    if (slide.claim.length > 120) {
      warnings.push(
        `slide_${index + 1}_claim_long: claim may overflow compact layouts.`,
      );
    }
    const bullets = bodyToBullets(slide.body);
    if (bullets.some((item) => item.length > 140)) {
      warnings.push(
        `slide_${index + 1}_bullet_long: body text may need manual tightening.`,
      );
    }
    if (
      slide.kind === "image" &&
      !input.source.assets.imageArtifactIds?.length
    ) {
      warnings.push(
        `slide_${index + 1}_image_missing: image slide has no imageArtifactIds.`,
      );
    }
  }
  return warnings;
}

function slideSize(source: DeckSource) {
  if (source.design.aspectRatio === "4:3") {
    return { w: 10, h: 7.5 };
  }
  if (source.design.aspectRatio === "16:10") {
    return { w: 10, h: 6.25 };
  }
  return { w: 13.33, h: 7.5 };
}

function contentFrame(source: DeckSource) {
  const size = slideSize(source);
  return {
    x: 0.58,
    y: 1.18,
    w: size.w - 1.16,
    h: size.h - 1.68,
  };
}

function themeFor(source: DeckSource) {
  if (source.design.stylePreset === "custom") {
    return buildCustomTheme(source);
  }
  return deckThemes[source.design.stylePreset] ?? deckThemes.custom;
}

function visualDeckFontsFor(source: DeckSource) {
  const designText =
    source.design.stylePreset === "custom" ? customDesignText(source) : "";
  const wantsSerifHeading =
    source.design.stylePreset === "editorial" ||
    /serif|editorial|magazine|book|literary|print|衬线|杂志|书/u.test(designText);
  const headingKey: VisualDeckFontKey =
    wantsSerifHeading
      ? source.design.resolvedLanguage === "zh"
        ? "noto-serif-sc"
        : "noto-serif"
      : source.design.resolvedLanguage === "zh"
        ? "noto-sans-sc"
        : "inter";
  const bodyKey: VisualDeckFontKey =
    source.design.resolvedLanguage === "zh" ? "noto-sans-sc" : "inter";
  return {
    body: visualDeckFontRegistry[bodyKey],
    heading: visualDeckFontRegistry[headingKey],
  };
}

function uniqueVisualDeckFonts(source: DeckSource) {
  const fonts = visualDeckFontsFor(source);
  return Array.from(
    new Map(
      [fonts.body, fonts.heading].map((font) => [font.key, font] as const),
    ).values(),
  );
}

function renderVisualDeckFontPreloads(source: DeckSource) {
  return uniqueVisualDeckFonts(source)
    .map(
      (font) =>
        `<link rel="preload" href="${escapeHtml(buildVisualDeckFontPublicUrl(font))}" as="font" type="font/ttf" crossorigin="anonymous" />`,
    )
    .join("\n");
}

function renderVisualDeckFontFaceCss(source: DeckSource) {
  return uniqueVisualDeckFonts(source)
    .map(
      (font) => `@font-face {
  font-family: ${JSON.stringify(font.cssFamily)};
  src: url("${buildVisualDeckFontPublicUrl(font)}") format("truetype");
  font-weight: ${Math.min(...font.weights)} ${Math.max(...font.weights)};
  font-style: normal;
  font-display: block;
}`,
    )
    .join("\n");
}

function visualDeckFontMetadata(source: DeckSource) {
  const fonts = visualDeckFontsFor(source);
  const fontToMetadata = (font: VisualDeckFontConfig) => ({
    key: font.key,
    family: font.family,
    cssFamily: font.cssFamily,
    weights: font.weights,
    roles: font.roles,
    webUrl: buildVisualDeckFontPublicUrl(font),
    embedUrl: buildVisualDeckFontPublicUrl(font),
    format: "truetype",
    license: "OFL-1.1",
    licenseUrl: buildVisualDeckLicensePublicUrl(font),
    sha256: font.sha256,
    bytes: font.bytes,
  });
  return {
    body: fontToMetadata(fonts.body),
    heading: fontToMetadata(fonts.heading),
    fonts: uniqueVisualDeckFonts(source).map(fontToMetadata),
  };
}

function htmlDataAttribute(value: unknown) {
  return escapeHtml(JSON.stringify(value));
}

function applySlideBackground(slide: LegacyPptxSlide, source: DeckSource) {
  const theme = themeFor(source);
  const size = slideSize(source);
  slide.background = { color: theme.background };
  slide.addShape("rect", {
    objectName: "sw:chrome:accent-rail",
    x: 0,
    y: 0,
    w: 0.16,
    h: size.h,
    fill: { color: theme.accent },
    line: { color: theme.accent },
  });
  slide.addShape("line", {
    objectName: "sw:chrome:footer-rule",
    x: 0.58,
    y: size.h - 0.42,
    w: size.w - 1.16,
    h: 0,
    line: { color: theme.grid, transparency: 35, width: 0.75 },
  });
}

function addTitle(
  slide: LegacyPptxSlide,
  source: DeckSource,
) {
  const theme = themeFor(source);
  const size = slideSize(source);
  const cover = source.deckSpec.cover;
  const title = cover.title;
  slide.background = { color: theme.background };
  slide.addShape("rect", {
    objectName: "sw:chrome:cover-background",
    x: 0,
    y: 0,
    w: size.w,
    h: size.h,
    fill: { color: theme.background },
    line: { color: theme.background },
  });
  slide.addShape("rect", {
    objectName: "sw:chrome:cover-accent-rail",
    x: 0.58,
    y: 0.55,
    w: 0.13,
    h: size.h - 1.1,
    fill: { color: theme.accent },
    line: { color: theme.accent },
  });
  slide.addShape("rect", {
    objectName: "sw:chrome:cover-side-panel",
    x: size.w - 2.6,
    y: 0,
    w: 2.6,
    h: size.h,
    fill: { color: theme.accent, transparency: 88 },
    line: { color: theme.accent, transparency: 100 },
  });
  if (cover.kicker) {
    slide.addText(cover.kicker, {
      objectName: "sw:content:cover-kicker",
      x: 0.92,
      y: 0.78,
      w: size.w - 3.2,
      h: 0.26,
      fontFace: theme.bodyFont,
      fontSize: 7.5,
      bold: true,
      color: theme.accent,
      margin: 0,
      fit: "shrink",
    });
  }
  slide.addText(title, {
    objectName: "sw:content:cover-title",
    x: 0.9,
    y: size.h > 7 ? 1.62 : 1.35,
    w: size.w - 3.35,
    h: 1.15,
    fontFace: theme.headingFont,
    fontSize: size.w < 11 ? 30 : 38,
    bold: true,
    color: theme.text,
    margin: 0,
    breakLine: false,
    fit: "shrink",
  });
  if (cover.subtitle) {
    slide.addText(cover.subtitle, {
      objectName: "sw:content:cover-subtitle",
      x: 0.92,
      y: size.h > 7 ? 2.92 : 2.5,
      w: size.w - 4.0,
      h: 1.0,
      fontFace: theme.bodyFont,
      fontSize: 16,
      color: theme.muted,
      breakLine: false,
      fit: "shrink",
      margin: 0,
    });
  }
  slide.addShape("line", {
    objectName: "sw:chrome:cover-footer-rule",
    x: 0.92,
    y: size.h - 0.72,
    w: size.w - 2.1,
    h: 0,
    line: { color: theme.grid, width: 1 },
  });
}

function addClaim(slide: LegacyPptxSlide, source: DeckSource, claim: string) {
  const theme = themeFor(source);
  const size = slideSize(source);
  applySlideBackground(slide, source);
  slide.addText(claim, {
    objectName: "sw:content:slide-claim",
    x: 0.58,
    y: 0.36,
    w: size.w - 1.16,
    h: 0.55,
    fontFace: theme.headingFont,
    fontSize: 22,
    bold: true,
    color: theme.text,
    margin: 0,
    fit: "shrink",
  });
  slide.addShape("line", {
    objectName: "sw:chrome:claim-rule",
    x: 0.58,
    y: 1.05,
    w: size.w - 1.16,
    h: 0,
    line: { color: theme.grid, width: 1 },
  });
}

function addSlideKickerAndFooter(
  slide: LegacyPptxSlide,
  source: DeckSource,
  slideSpec: SlideSpec,
) {
  const theme = themeFor(source);
  const size = slideSize(source);
  if (slideSpec.kicker) {
    slide.addText(slideSpec.kicker, {
      objectName: "sw:content:slide-kicker",
      x: 0.58,
      y: 0.12,
      w: size.w - 1.16,
      h: 0.2,
      fontFace: theme.bodyFont,
      fontSize: 7.5,
      bold: true,
      color: theme.muted,
      margin: 0,
      fit: "shrink",
    });
  }
  if (slideSpec.footer) {
    slide.addText(slideSpec.footer, {
      objectName: "sw:content:slide-footer",
      x: 0.58,
      y: size.h - 0.31,
      w: size.w - 1.16,
      h: 0.18,
      fontFace: theme.bodyFont,
      fontSize: 7,
      color: theme.muted,
      margin: 0,
      fit: "shrink",
    });
  }
}

function slideHeading(slide: SlideSpec) {
  return slide.title?.trim() || slide.claim;
}

function addBullets(
  slide: LegacyPptxSlide,
  source: DeckSource,
  bullets: string[],
  y = 1.35,
) {
  const theme = themeFor(source);
  const frame = contentFrame(source);
  if (bullets.length === 0) {
    return;
  }
  const useCards = bullets.length <= 5;
  if (useCards) {
    const cardGap = 0.14;
    const cardH = Math.min(
      0.76,
      (frame.h - 0.45) / Math.max(bullets.length, 1),
    );
    bullets.slice(0, 5).forEach((text, index) => {
      const itemY = y + index * (cardH + cardGap);
      const marker = index === 0 ? "|" : "/";
      slide.addText(`${marker} ${text}`, {
        objectName: `sw:content:bullet-card-${index + 1}`,
        x: frame.x + 0.18,
        y: itemY,
        w: frame.w - 0.36,
        h: cardH,
        fontFace: theme.bodyFont,
        fontSize: 15,
        color: theme.text,
        breakLine: false,
        fit: "shrink",
        margin: 0.12,
        fill: { color: theme.card },
        line: { color: theme.grid, transparency: 20, width: 0.75 },
      });
    });
    return;
  }
  slide.addText(
    bullets.map((text) => ({ text, options: { bullet: { indent: 18 } } })),
    {
      objectName: "sw:content:bullet-list",
      x: frame.x + 0.3,
      y,
      w: frame.w - 0.6,
      h: frame.h - 0.35,
      fontFace: theme.bodyFont,
      fontSize: 16,
      color: theme.text,
      breakLine: false,
      fit: "shrink",
      paraSpaceAfter: 9,
      margin: 0.04,
    },
  );
}

function addTable(slide: LegacyPptxSlide, source: DeckSource, rows: string[][]) {
  const theme = themeFor(source);
  const frame = contentFrame(source);
  if (rows.length === 0) {
    return;
  }
  const tableRows = rows.map((row, rowIndex) =>
    row.map((cell) => ({
      text: cell,
      options: {
        bold: rowIndex === 0,
        color: rowIndex === 0 ? theme.onAccent : theme.text,
        fill: { color: rowIndex === 0 ? theme.accent : theme.card },
      },
    })),
  );
  slide.addTable(tableRows, {
    objectName: "sw:content:table",
    x: frame.x + 0.12,
    y: frame.y + 0.12,
    w: frame.w - 0.24,
    h: frame.h - 0.3,
    border: { color: theme.grid, pt: 1 },
    color: theme.text,
    fontFace: theme.bodyFont,
    fontSize: 13,
    margin: 0.09,
    fill: { color: theme.card },
    valign: "middle",
  });
}

function addChart(
  slide: LegacyPptxSlide,
  source: DeckSource,
  data: Array<{ name: string; value: number }>,
) {
  const theme = themeFor(source);
  const frame = contentFrame(source);
  if (data.length === 0) {
    return;
  }
  slide.addChart(
    "bar",
    [
      {
        name: source.design.resolvedLanguage === "zh" ? "数值" : "Value",
        labels: data.map((item) => item.name),
        values: data.map((item) => item.value),
      },
    ],
    {
      objectName: "sw:content:chart",
      x: frame.x + 0.28,
      y: frame.y + 0.22,
      w: frame.w - 0.56,
      h: frame.h - 0.46,
      chartColors: theme.chartColors,
      chartArea: {
        fill: { color: theme.card },
        border: { color: theme.card, pt: 0 },
      },
      plotArea: {
        fill: { color: theme.card, transparency: 100 },
        border: { color: theme.card, pt: 0 },
      },
      showLegend: false,
      showValue: true,
      valAxisLabelColor: theme.muted,
      valAxisLineColor: theme.grid,
      catAxisLabelColor: theme.text,
      catAxisLineColor: theme.grid,
    },
  );
}

function addComparison(
  slide: LegacyPptxSlide,
  source: DeckSource,
  slideSpec: SlideSpec,
) {
  const theme = themeFor(source);
  const frame = contentFrame(source);
  const groups = normalizeComparisonGroups(slideSpec).slice(0, 3);
  if (groups.length === 0) {
    return;
  }
  const gap = 0.16;
  const columnW = (frame.w - gap * (groups.length - 1)) / groups.length;
  groups.forEach((group, index) => {
    const x = frame.x + index * (columnW + gap);
    const title = group.title?.trim();
    const lines = [
      ...(title ? [title] : []),
      ...group.bullets.map((bullet) => `- ${bullet}`),
    ];
    slide.addText(lines.join("\n"), {
      objectName: `sw:content:comparison-column-${index + 1}`,
      x,
      y: frame.y + 0.08,
      w: columnW,
      h: frame.h - 0.22,
      fontFace: theme.bodyFont,
      fontSize: 13.5,
      bold: Boolean(title),
      color: theme.text,
      breakLine: false,
      fit: "shrink",
      margin: 0.14,
      paraSpaceAfter: 7,
      fill: { color: theme.card },
      line: {
        color: index === 0 ? theme.accent : theme.grid,
        transparency: index === 0 ? 0 : 15,
        width: index === 0 ? 1.2 : 0.75,
      },
    });
  });
}

function addNotes(slide: LegacyPptxSlide, notes?: string) {
  if (notes) {
    slide.addNotes(notes);
  }
}

type TableCellLike = {
  attrs: Record<string, string>;
  innerText: string;
  offsetWidth: number;
  style: Record<string, string>;
  tagName: "TH" | "TD";
  getAttribute(name: string): string | null;
};

type TableRowLike = {
  cells: TableCellLike[];
};

function createHtmlTableShim(
  id: string,
  rows: string[][],
  theme: DeckTheme,
): {
  document: {
    getElementById(queryId: string): unknown;
    querySelector(selector: string): TableCellLike | null;
    querySelectorAll(selector: string): TableCellLike[] | TableRowLike[];
  };
  window: {
    getComputedStyle(cell: TableCellLike): {
      getPropertyValue(property: string): string;
    };
  };
} {
  const colCount = Math.max(1, ...rows.map((row) => row.length));
  const colWidth = Math.max(90, Math.round(720 / colCount));
  const makeCell = (
    tagName: "TH" | "TD",
    text: string,
    rowIndex: number,
  ): TableCellLike => {
    const isHeader = tagName === "TH";
    return {
      attrs: {},
      innerText: text,
      offsetWidth: colWidth,
      style: {
        color: isHeader ? `#${theme.onAccent}` : `#${theme.text}`,
        backgroundColor: isHeader
          ? `#${theme.accent}`
          : rowIndex % 2 === 0
            ? `#${theme.card}`
            : `#${theme.background}`,
        fontWeight: isHeader ? "700" : "400",
        fontFamily: theme.bodyFont,
        fontSize: isHeader ? "12px" : "11px",
        textAlign: isHeader ? "center" : "left",
        verticalAlign: "middle",
      },
      tagName,
      getAttribute(name) {
        return this.attrs[name] ?? null;
      },
    };
  };
  const headerRows: TableRowLike[] = [
    {
      cells: (rows[0] ?? []).map((cell) => makeCell("TH", cell, 0)),
    },
  ];
  const bodyRows: TableRowLike[] = rows.slice(1).map((row, index) => ({
    cells: row.map((cell) => makeCell("TD", cell, index)),
  }));
  const allRows = [...headerRows, ...bodyRows];
  const firstHeader = headerRows[0]?.cells ?? [];

  const matchesNthHeader = (selector: string) => {
    const match = selector.match(
      new RegExp(`#${id} thead tr:first-child th:nth-child\\((\\d+)\\)`),
    );
    return match?.[1] ? Number(match[1]) - 1 : null;
  };

  const document = {
    getElementById(queryId: string) {
      return queryId === id ? { rows: allRows } : null;
    },
    querySelector(selector: string) {
      const headerIndex = matchesNthHeader(selector);
      return headerIndex === null ? null : (firstHeader[headerIndex] ?? null);
    },
    querySelectorAll(selector: string) {
      if (selector === `#${id} tr:first-child th`) {
        return firstHeader;
      }
      if (selector === `#${id} tr:first-child td`) {
        return [];
      }
      if (selector === `#${id} thead tr`) {
        return headerRows;
      }
      if (selector === `#${id} tbody tr`) {
        return bodyRows;
      }
      if (selector === `#${id} tfoot tr`) {
        return [];
      }
      return [];
    },
  };

  const normalizedDocument = document as {
    getElementById(queryId: string): unknown;
    querySelector(selector: string): TableCellLike | null;
    querySelectorAll(selector: string): TableCellLike[] | TableRowLike[];
  };

  const window = {
    getComputedStyle(cell: TableCellLike) {
      return {
        getPropertyValue(property: string) {
          const values: Record<string, string> = {
            color: cell.style.color ?? "#000000",
            "background-color": cell.style.backgroundColor ?? "#FFFFFF",
            "font-weight": cell.style.fontWeight ?? "400",
            "font-family": cell.style.fontFamily ?? "Aptos",
            "font-size": cell.style.fontSize ?? "11px",
            "text-align": cell.style.textAlign ?? "left",
            "vertical-align": cell.style.verticalAlign ?? "middle",
            "padding-top": "5px",
            "padding-right": "7px",
            "padding-bottom": "5px",
            "padding-left": "7px",
            "border-top-width": "1px",
            "border-right-width": "1px",
            "border-bottom-width": "1px",
            "border-left-width": "1px",
            "border-top-color": `#${theme.grid}`,
            "border-right-color": `#${theme.grid}`,
            "border-bottom-color": `#${theme.grid}`,
            "border-left-color": `#${theme.grid}`,
          };
          return values[property] ?? "";
        },
      };
    },
  };

  return { document: normalizedDocument, window };
}

function addHtmlTableSlides(
  pptxDoc: LegacyPptxDocument,
  source: DeckSource,
  slideSpec: SlideSpec,
  rows: string[][],
) {
  const theme = themeFor(source);
  const frame = contentFrame(source);
  const tableId = `sourceweft_table_${randomUUID().replace(/-/g, "")}`;
  const shim = createHtmlTableShim(tableId, rows, theme);
  const globalWithDom = globalThis as unknown as {
    document?: unknown;
    window?: unknown;
  };
  const previousDocument = globalWithDom.document;
  const previousWindow = globalWithDom.window;
  const startSlideCount =
    (pptxDoc as unknown as { _slides?: unknown[] })._slides?.length ?? 0;
  try {
    globalWithDom.document = shim.document;
    globalWithDom.window = shim.window;
    pptxDoc.tableToSlides(tableId, {
      x: frame.x + 0.12,
      y: frame.y + 0.18,
      w: frame.w - 0.24,
      h: frame.h - 0.42,
      autoPage: true,
      autoPageRepeatHeader: true,
      autoPageSlideStartY: frame.y + 0.18,
      slideMargin: 0.42,
      addText: {
        text: [{ text: slideSpec.claim }],
        options: {
          objectName: "sw:content:table-title",
          x: 0.58,
          y: 0.34,
          w: slideSize(source).w - 1.16,
          h: 0.52,
          fontFace: theme.headingFont,
          fontSize: 21,
          bold: true,
          color: theme.text,
          margin: 0,
          fit: "shrink",
        },
      },
      addShape: {
        shapeName: "line",
        options: {
          objectName: "sw:chrome:table-title-rule",
          x: 0.58,
          y: 1.05,
          w: slideSize(source).w - 1.16,
          h: 0,
          line: { color: theme.grid, width: 1 },
        },
      },
    });
  } finally {
    if (previousDocument === undefined) {
      globalWithDom.document = undefined;
    } else {
      globalWithDom.document = previousDocument;
    }
    if (previousWindow === undefined) {
      globalWithDom.window = undefined;
    } else {
      globalWithDom.window = previousWindow;
    }
  }

  const slides = pptxDoc._slides;
  slides?.slice(startSlideCount).forEach((slide) => {
    applySlideBackground(slide, source);
    addNotes(slide, slideSpec.notes);
  });
}

async function buildPptxBuffer(source: DeckSource) {
  return (await buildComposerPptxArtifact(source, { failOnQaErrors: false, failOnRenderQaErrors: false })).artifactBuffer;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cssColor(hex: string) {
  return `#${hex.replace(/^#/, "")}`;
}

function slidePixelSize(source: DeckSource) {
  if (source.design.aspectRatio === "16:10") {
    return { width: 1920, height: 1200 };
  }
  if (source.design.aspectRatio === "4:3") {
    return { width: 1440, height: 1080 };
  }
  return { width: 1920, height: 1080 };
}

function normalizeComparisonGroups(slide: SlideSpec) {
  const body = slide.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    const columns = Array.isArray(record.columns) ? record.columns : [];
    const groups = columns
      .map((column, index) => {
        const columnRecord =
          column && typeof column === "object" && !Array.isArray(column)
            ? (column as Record<string, unknown>)
            : null;
        const title =
          typeof columnRecord?.title === "string"
            ? columnRecord.title
            : undefined;
        return {
          title,
          bullets: bodyToBullets(columnRecord?.items ?? columnRecord?.bullets),
        };
      })
      .filter((group) => group.bullets.length > 0)
      .slice(0, 3);
    if (groups.length > 0) {
      return groups;
    }
    const left = bodyToBullets(record.left);
    const right = bodyToBullets(record.right);
    if (left.length > 0 || right.length > 0) {
      return [
        {
          title:
            typeof record.leftTitle === "string" ? record.leftTitle : undefined,
          bullets: left,
        },
        {
          title:
            typeof record.rightTitle === "string"
              ? record.rightTitle
              : undefined,
          bullets: right,
        },
      ];
    }
  }

  const bullets = bodyToBullets(slide.body);
  const splitIndex = Math.ceil(bullets.length / 2);
  return [
    { title: undefined, bullets: bullets.slice(0, splitIndex) },
    { title: undefined, bullets: bullets.slice(splitIndex) },
  ].filter((group) => group.bullets.length > 0);
}

function renderBulletCards(
  slide: SlideSpec,
  resolved?: ResolvedVisualSlide,
  system?: CompiledVisualSystem,
) {
  const bullets = bodyToBullets(slide.body);
  const items = bullets.slice(0, 6);
  if (items.length === 0) {
    return renderParagraphSlide(slide);
  }
  if (items.length === 1) {
    return renderParagraphSlide(slide);
  }
  const layoutClass = resolved?.layoutId ?? "visual-content";
  const markerLabel =
    system?.family === "education" && system.illustration === "handdrawn"
      ? "?"
      : undefined;
  return `<div class="bullet-grid ${escapeHtml(layoutClass)}">${items
    .map(
      (item, index) =>
        `<div class="bullet-card" data-anim style="--i:${index}"><span>${escapeHtml(markerLabel ?? index + 1)}</span><p>${escapeHtml(item)}</p></div>`,
    )
    .join("")}</div>`;
}

function renderCardsSlide(
  slide: SlideSpec,
  resolved?: ResolvedVisualSlide,
  system?: CompiledVisualSystem,
) {
  return renderBulletCards(slide, resolved, system);
}

function renderParagraphSlide(slide: SlideSpec) {
  const paragraphs = bodyToBullets(slide.body);
  const text =
    paragraphs.length > 0
      ? paragraphs.join("\n")
      : textFromSlideBody(slide.body);
  const safeText = text || slide.caption || slide.claim;
  if (!safeText) {
    return "";
  }
  return `<div class="paragraph-panel" data-anim><p>${escapeHtml(safeText)}</p></div>`;
}

function renderStepBoard(slide: SlideSpec) {
  const steps = bodyToBullets(slide.body).slice(0, 5);
  return `<div class="step-board">${steps
    .map(
      (step, index) =>
        `<div class="step-row" data-anim style="--i:${index}"><span>${String(index + 1).padStart(2, "0")}</span><p>${escapeHtml(step)}</p></div>`,
    )
    .join("")}</div>`;
}

function renderTableSlide(slide: SlideSpec, source: DeckSource) {
  const rows = normalizeRowsForHtml(slide.body);
  return `<div class="table-wrap" data-anim><table><tbody>${rows
    .map(
      (row, rowIndex) =>
        `<tr>${row
          .map((cell) =>
            rowIndex === 0
              ? `<th>${escapeHtml(cell)}</th>`
              : `<td>${escapeHtml(cell)}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function renderChartSlide(
  slide: SlideSpec,
  source: DeckSource,
  system?: CompiledVisualSystem,
) {
  const theme = system?.theme ?? themeFor(source);
  const data = normalizeChartData(slide.body);
  if (data.length === 0) {
    return `<div class="chart-panel is-empty" data-anim></div>`;
  }
  const max = Math.max(...data.map((item) => Math.abs(item.value)), 1);
  return `<div class="chart-panel" data-anim>${data
    .map((item, index) => {
      const width = Math.max(8, Math.round((Math.abs(item.value) / max) * 100));
      const color = cssColor(
        theme.chartColors[index % theme.chartColors.length] ?? theme.accent,
      );
      return `<div class="chart-row"><div class="chart-label">${escapeHtml(item.name)}</div><div class="chart-track"><div class="chart-fill" style="--bar:${width}%;--bar-color:${color}"></div></div><div class="chart-value">${escapeHtml(item.value)}</div></div>`;
    })
    .join("")}</div>`;
}

function renderComparisonSlide(slide: SlideSpec) {
  const groups = normalizeComparisonGroups(slide);
  return `<div class="comparison-grid">${groups
    .map(
      (group, groupIndex) =>
        `<div class="comparison-card" data-anim style="--i:${groupIndex}">${group.title ? `<h3>${escapeHtml(group.title)}</h3>` : ""}${group.bullets
          .slice(0, 5)
          .map((item) => `<p>${escapeHtml(item)}</p>`)
          .join("")}</div>`,
    )
    .join("")}</div>`;
}

function renderQuoteSlide(slide: SlideSpec) {
  const bodyRecord =
    slide.body && typeof slide.body === "object" && !Array.isArray(slide.body)
      ? (slide.body as Record<string, unknown>)
      : null;
  const quote =
    (typeof bodyRecord?.quote === "string" ? bodyRecord.quote.trim() : "") ||
    bodyToBullets(slide.body)[0] ||
    slide.claim;
  const attribution =
    (typeof bodyRecord?.attribution === "string"
      ? bodyRecord.attribution.trim()
      : "") || slide.caption;
  return `<figure class="quote-block" data-anim><blockquote>${escapeHtml(quote)}</blockquote>${attribution ? `<figcaption>${escapeHtml(attribution)}</figcaption>` : ""}</figure>`;
}

function renderImageSlide(slide: SlideSpec, resolved?: ResolvedVisualSlide) {
  return `<div class="visual-split"><div class="image-placeholder" data-anim ${resolved?.imageSlot ? `data-image-slot="${escapeHtml(resolved.imageSlot)}"` : ""}><div></div>${slide.caption ? `<span>${escapeHtml(slide.caption)}</span>` : ""}</div>${slide.caption ? `<div class="caption-panel" data-anim style="--i:1"><p>${escapeHtml(slide.caption)}</p></div>` : ""}</div>`;
}

function renderSummarySlide(slide: SlideSpec) {
  const bullets = bodyToBullets(slide.body).slice(0, 6);
  if (bullets.length === 0) {
    return renderParagraphSlide(slide);
  }
  return `<div class="summary-panel">${bullets
    .map(
      (item, index) =>
        `<div class="summary-row" data-anim style="--i:${index}"><span>${String(index + 1).padStart(2, "0")}</span><p>${escapeHtml(item)}</p></div>`,
    )
    .join("")}</div>`;
}

function renderClosingSlide(slide: SlideSpec) {
  return renderSummarySlide(slide);
}

function renderVisualSceneNode(node: VisualSceneNode, index: number) {
  const attrs = [
    `class="scene-node scene-${escapeHtml(node.kind)} scene-${escapeHtml(node.position)} scene-${escapeHtml(node.emphasis)}"`,
    `data-node-kind="${escapeHtml(node.kind)}"`,
    `data-node-role="${escapeHtml(node.role)}"`,
    `data-node-position="${escapeHtml(node.position)}"`,
    `data-node-emphasis="${escapeHtml(node.emphasis)}"`,
    `style="--i:${index}"`,
    "data-anim",
  ].join(" ");
  if (node.kind === "text-slot") {
    const tag = node.role === "title" ? "h1" : "p";
    return `<${tag} ${attrs}>${escapeHtml(node.text ?? "")}</${tag}>`;
  }
  if (node.kind === "metric") {
    return `<div ${attrs}><span>${escapeHtml(node.text ?? node.token ?? "")}</span></div>`;
  }
  if (node.kind === "divider") {
    return `<div ${attrs}></div>`;
  }
  if (node.kind === "diagram") {
    return `<div ${attrs}><span></span><span></span><span></span></div>`;
  }
  if (node.kind === "media-slot") {
    return `<div ${attrs}><span>${escapeHtml(node.text ?? "")}</span></div>`;
  }
  return `<div ${attrs}>${node.text ? `<span>${escapeHtml(node.text)}</span>` : ""}</div>`;
}

function renderCoverScene(input: {
  cover: DeckSpec["cover"];
  index: number;
  scene?: CompiledVisualScene;
  slide: SlideSpec;
  slideNo: string;
  source: DeckSource;
  system: CompiledVisualSystem;
}) {
  const scene =
    input.scene ??
    {
      family: input.system.family,
      layoutId: `${input.system.family}-cover`,
      nodes: defaultCoverSceneNodes({
        cover: input.cover,
        slide: input.slide,
        system: input.system,
      }),
      sceneId: `visual-scene-${input.index + 1}`,
      slideIndex: input.index,
      treatment: input.system.coverTreatment,
      warnings: [],
    };
  return `<div class="cover-scene cover-${escapeHtml(input.system.family)} cover-${escapeHtml(scene.treatment)}" data-sourceweft-scene="${htmlDataAttribute({
    id: scene.sceneId,
    treatment: scene.treatment,
    family: scene.family,
  })}">
      <div class="slide-topline"><span></span><span>${input.slideNo}</span></div>
      ${scene.nodes.map((node, nodeIndex) => renderVisualSceneNode(node, nodeIndex)).join("")}
    </div>`;
}

function renderSlideBody(
  slide: SlideSpec,
  source: DeckSource,
  resolved?: ResolvedVisualSlide,
  system?: CompiledVisualSystem,
) {
  if (slide.kind === "table") {
    return renderTableSlide(slide, source);
  }
  if (slide.kind === "chart") {
    return renderChartSlide(slide, source, system);
  }
  if (slide.kind === "comparison") {
    return renderComparisonSlide(slide);
  }
  if (slide.kind === "quote") {
    return renderQuoteSlide(slide);
  }
  if (slide.kind === "image") {
    return renderImageSlide(slide, resolved);
  }
  if (slide.kind === "closing" || resolved?.contentShape === "closing") {
    return renderClosingSlide(slide);
  }
  if (resolved?.contentShape === "paragraph") {
    return renderParagraphSlide(slide);
  }
  if (resolved?.contentShape === "steps" || resolved?.contentShape === "practice") {
    return renderStepBoard(slide);
  }
  return renderCardsSlide(slide, resolved, system);
}

function renderVisualSlide(
  slide: SlideSpec,
  source: DeckSource,
  index: number,
  resolved: ResolvedVisualSlide,
  system: CompiledVisualSystem,
  scene?: CompiledVisualScene,
) {
  const slideNo = String(index + 1).padStart(2, "0");
  const dataAttrs = `data-slide-index="${index}" data-kind="${slide.kind}" data-layout="${escapeHtml(resolved.layoutId)}" data-macro-layout="${escapeHtml(resolved.macroLayout)}" data-visual-role="${escapeHtml(resolved.role)}"${scene ? ` data-cover-treatment="${escapeHtml(scene.treatment)}" data-sourceweft-scene-id="${escapeHtml(scene.sceneId)}"` : ""}`;
  if (slide.kind === "title") {
    const cover = source.deckSpec.cover;
    return `<section class="sw-slide slide-title ${index === 0 ? "is-active" : ""}" ${dataAttrs}>
      ${renderCoverScene({ cover, index, scene, slide, slideNo, source, system })}
    </section>`;
  }

  if (slide.kind === "section") {
    return `<section class="sw-slide slide-section ${index === 0 ? "is-active" : ""}" ${dataAttrs}>
      <div class="section-mark">${slideNo}</div>
      <h2 data-anim>${escapeHtml(slideHeading(slide))}</h2>
      <div class="section-line" data-anim style="--i:1"></div>
    </section>`;
  }

  return `<section class="sw-slide slide-content ${index === 0 ? "is-active" : ""}" ${dataAttrs}>
    <div class="slide-topline">${slide.kicker ? `<span>${escapeHtml(slide.kicker)}</span>` : "<span></span>"}<span>${slideNo}</span></div>
    <h2 data-anim>${escapeHtml(slideHeading(slide))}</h2>
    <div class="slide-body">${renderSlideBody(slide, source, resolved, system)}</div>
    ${slide.footer ? `<p class="slide-footer">${escapeHtml(slide.footer)}</p>` : ""}
  </section>`;
}

function buildVisualHtml(source: DeckSource) {
  const visualMetadata = extractVisualDeckMetadata(source);
  const system = visualMetadata.compiledVisualSystem;
  const theme = system.theme;
  const tokens = system.tokens;
  const fonts = visualDeckFontsFor(source);
  const fontMetadata = visualDeckFontMetadata(source);
  const size = slidePixelSize(source);
  const slidesHtml = source.slides
    .map((slide, index) =>
      renderVisualSlide(
        slide,
        source,
        index,
        visualMetadata.resolvedLayouts[index] ?? {
          contentShape: classifySlideContentShape(slide, index),
          family: system.family,
          layoutId: `${system.family}-content`,
          macroLayout: "content",
          role: resolveVisualLayoutRole(slide, index),
          slideIndex: index,
        },
        system,
        visualMetadata.compiledVisualScenes.find(
          (scene) => scene.slideIndex === index,
        ),
      ),
    )
    .join("\n");
  const html = `<!doctype html>
<html lang="${source.design.resolvedLanguage === "zh" ? "zh-CN" : "en"}" data-sourceweft-deck="visual_html" data-sourceweft-aspect="${source.design.aspectRatio}" data-sourceweft-style="${source.design.stylePreset}" data-sourceweft-family="${system.family}" data-sourceweft-layout="${tokens.layout}" data-sourceweft-density="${system.density}" data-sourceweft-geometry="${system.geometry}" data-sourceweft-chrome="${system.chrome}" data-sourceweft-illustration="${system.illustration}" data-sourceweft-fonts="${htmlDataAttribute(fontMetadata)}" data-sourceweft-visual-system="${htmlDataAttribute({
    version: visualMetadata.visualSystemVersion,
    family: system.family,
    density: system.density,
    geometry: system.geometry,
    chrome: system.chrome,
    illustration: system.illustration,
    compositionStyle: system.compositionStyle,
    backgroundTreatment: system.backgroundTreatment,
    coverTreatment: system.coverTreatment,
    layoutPolicy: system.layoutPolicy,
    motion: system.motion,
    compiledVisualScenes: visualMetadata.compiledVisualScenes.map((scene) => ({
      index: scene.slideIndex,
      treatment: scene.treatment,
      nodes: scene.nodes.map((node) => node.kind),
    })),
    resolvedLayouts: visualMetadata.resolvedLayouts.map((layout) => ({
      index: layout.slideIndex,
      id: layout.layoutId,
      macro: layout.macroLayout,
      role: layout.role,
      contentShape: layout.contentShape,
    })),
    sceneWarnings: visualMetadata.sceneWarnings,
    qaWarnings: visualMetadata.qaWarnings,
  })}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(source.title)}</title>
${renderVisualDeckFontPreloads(source)}
<style>
${renderVisualDeckFontFaceCss(source)}
:root {
  --slide-w: ${size.width}px;
  --slide-h: ${size.height}px;
  --bg: ${cssColor(theme.background)};
  --card: ${cssColor(theme.card)};
  --text: ${cssColor(theme.text)};
  --muted: ${cssColor(theme.muted)};
  --accent: ${cssColor(theme.accent)};
  --accent-2: ${cssColor(theme.accent2)};
  --grid: ${cssColor(theme.grid)};
  --section-bg: ${cssColor(theme.sectionBackground)};
  --section-text: ${cssColor(theme.sectionText)};
  --on-accent: ${cssColor(theme.onAccent)};
  --card-radius: ${tokens.cardRadius}px;
  --deck-shadow: ${tokens.shadow};
  --pattern-opacity: ${tokens.patternOpacity};
  --title-scale: ${tokens.titleScale};
  color-scheme: light;
  --font-body: ${JSON.stringify(fonts.body.cssFamily)}, ${fonts.body.fallback};
  --font-heading: ${JSON.stringify(fonts.heading.cssFamily)}, ${fonts.heading.fallback};
}
* { box-sizing: border-box; }
html, body { margin: 0; width: 100%; min-height: 100%; background: #0b1017; color: var(--text); font-family: var(--font-body); }
body { overflow: hidden; }
.deck-viewport { position: fixed; inset: 0 0 48px; display: block; min-height: 0; overflow: hidden; padding: 0; background: linear-gradient(135deg, #080b10, #141922); }
.deck-shell { position: absolute; width: var(--slide-w); height: var(--slide-h); transform-origin: top left; will-change: transform; }
.sw-slide { position: absolute; inset: 0; width: var(--slide-w); height: var(--slide-h); overflow: hidden; background: var(--bg); color: var(--text); visibility: hidden; opacity: 0; transform: translateX(36px) scale(0.985); transition: opacity 360ms ease, transform 520ms ease; }
.sw-slide.is-active { visibility: visible; opacity: 1; transform: translateX(0) scale(1); }
.sw-slide::before { content: ""; position: absolute; inset: 0; background: linear-gradient(115deg, color-mix(in srgb, var(--accent) 9%, transparent), transparent 48%), linear-gradient(0deg, transparent 94%, color-mix(in srgb, var(--grid) 34%, transparent) 95%); opacity: var(--pattern-opacity); pointer-events: none; }
.sw-slide::after { content: ""; position: absolute; right: 64px; bottom: 54px; width: 280px; height: 2px; background: linear-gradient(90deg, var(--accent), var(--accent-2)); opacity: .65; }
.slide-topline { position: absolute; left: 72px; right: 72px; top: 54px; z-index: 2; display: flex; justify-content: space-between; align-items: center; color: var(--muted); font-size: 22px; font-weight: 700; text-transform: uppercase; }
.slide-title { padding: 0; }
.cover-scene { position: absolute; inset: 0; z-index: 2; display: grid; grid-template-columns: repeat(12, 1fr); grid-template-rows: repeat(8, 1fr); gap: 24px; padding: 116px 112px 92px; }
.scene-node { position: relative; z-index: 2; min-width: 0; }
.scene-text-slot { align-self: center; }
.scene-text-slot[data-node-role="kicker"] { grid-column: 1 / span 5; grid-row: 1; margin: 0; color: var(--accent); font-size: 26px; font-weight: 820; text-transform: uppercase; }
.scene-text-slot[data-node-role="title"] { grid-column: 1 / span 8; grid-row: 2 / span 4; margin: 0; font-family: var(--font-heading); font-size: clamp(72px, calc(7vw * var(--title-scale)), 150px); line-height: .96; font-weight: 860; }
.scene-text-slot[data-node-role="subtitle"] { grid-column: 1 / span 7; grid-row: 7 / span 2; margin: 0; color: var(--muted); font-size: 36px; line-height: 1.32; }
.scene-panel { border: 2px solid color-mix(in srgb, var(--grid) 70%, transparent); background: color-mix(in srgb, var(--card) 74%, transparent); border-radius: var(--card-radius); box-shadow: var(--deck-shadow); }
.scene-shape { border: 2px solid color-mix(in srgb, var(--accent) 58%, transparent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.scene-divider { min-height: 4px; background: var(--accent); }
.scene-diagram { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; align-items: center; border: 1px solid color-mix(in srgb, var(--grid) 72%, transparent); background-image: linear-gradient(90deg, color-mix(in srgb, var(--grid) 36%, transparent) 1px, transparent 1px), linear-gradient(0deg, color-mix(in srgb, var(--grid) 36%, transparent) 1px, transparent 1px); background-size: 46px 46px; }
.scene-diagram span { display: block; height: 42%; border: 2px solid var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.scene-media-slot { display: grid; place-items: center; overflow: hidden; border-radius: var(--card-radius); background: linear-gradient(135deg, var(--section-bg), var(--accent)); color: var(--section-text); }
.scene-metric { display: grid; place-items: center; color: var(--accent); font-family: var(--font-heading); font-size: 112px; line-height: 1; font-weight: 820; }
.scene-left { grid-column: 1 / span 2; grid-row: 2 / span 5; }
.scene-right { grid-column: 9 / span 4; grid-row: 2 / span 6; }
.scene-center { grid-column: 2 / span 10; grid-row: 2 / span 5; }
.scene-bottom { grid-column: 1 / span 8; grid-row: 7 / span 2; }
.scene-accent { grid-column: 10 / span 3; grid-row: 1 / span 2; }
.cover-education .scene-panel { grid-column: 1 / span 8; grid-row: 2 / span 6; transform: rotate(-1.5deg); border-style: dashed; }
.cover-education .scene-diagram { grid-column: 9 / span 4; grid-row: 3 / span 4; border-radius: 28px; }
.cover-education .scene-shape { border-radius: 999px; }
.cover-blueprint .scene-diagram { grid-column: 8 / span 5; grid-row: 1 / span 7; border-radius: 0; }
.cover-blueprint .scene-divider { grid-column: 1; grid-row: 2 / span 6; width: 8px; min-height: 100%; }
.cover-blueprint .scene-shape { grid-column: 8 / span 5; grid-row: 8; height: 2px; border: 0; background: var(--accent); }
.cover-swiss .scene-metric { grid-column: 1 / span 2; grid-row: 1 / span 2; justify-items: start; place-items: start; }
.cover-swiss .scene-text-slot[data-node-role="title"] { grid-column: 4 / span 7; grid-row: 3 / span 4; font-family: var(--font-body); font-weight: 400; }
.cover-swiss .scene-divider { grid-column: 4 / span 8; grid-row: 8; height: 2px; }
.cover-data-report .scene-metric { grid-column: 9 / span 4; grid-row: 2 / span 3; background: color-mix(in srgb, var(--accent) 12%, var(--card)); border: 2px solid var(--grid); }
.cover-data-report .scene-panel { grid-column: 1 / span 12; grid-row: 7 / span 2; border-radius: 0; }
.cover-magazine .scene-media-slot, .cover-editorial .scene-media-slot { grid-column: 8 / span 5; grid-row: 1 / span 8; border-radius: 0; }
.cover-magazine .scene-shape, .cover-editorial .scene-shape { grid-column: 7 / span 2; grid-row: 2 / span 5; border-radius: 0; }
.eyebrow { margin: 0 0 26px; color: var(--accent); font-size: 28px; font-weight: 800; text-transform: uppercase; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 36px; font-family: var(--font-heading); font-size: clamp(72px, calc(7vw * var(--title-scale)), 150px); line-height: .98; font-weight: 860; max-width: 1220px; }
.subtitle { max-width: 1080px; color: var(--muted); font-size: 38px; line-height: 1.35; }
.title-rail { position: absolute; right: 120px; top: 160px; bottom: 120px; display: grid; gap: 24px; width: 108px; }
.title-rail span { background: linear-gradient(180deg, var(--accent), var(--accent-2)); opacity: .92; }
.slide-content { padding: 132px 92px 78px; }
.slide-content h2 { position: relative; z-index: 2; max-width: 1360px; margin-bottom: 54px; font-family: var(--font-heading); font-size: 58px; line-height: 1.04; font-weight: 820; }
.slide-body { position: relative; z-index: 2; }
.bullet-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 28px; }
.bullet-card { min-height: 154px; display: grid; grid-template-columns: 72px 1fr; gap: 28px; align-items: start; padding: 30px; background: color-mix(in srgb, var(--card) 88%, transparent); border: 2px solid color-mix(in srgb, var(--grid) 72%, transparent); border-radius: var(--card-radius); box-shadow: var(--deck-shadow); }
.bullet-card span { display: grid; place-items: center; width: 64px; height: 64px; background: var(--accent); color: var(--on-accent); font-size: 26px; font-weight: 850; }
.bullet-card p { margin: 0; font-size: 32px; line-height: 1.28; color: var(--text); }
.paragraph-panel { max-width: 1420px; min-height: 440px; display: flex; align-items: center; padding: 58px 66px; background: color-mix(in srgb, var(--card) 90%, transparent); border: 2px solid color-mix(in srgb, var(--grid) 72%, transparent); border-radius: var(--card-radius); box-shadow: var(--deck-shadow); }
.paragraph-panel p { margin: 0; color: var(--text); font-size: 42px; line-height: 1.34; font-weight: 620; }
.step-board { display: grid; gap: 20px; max-width: 1440px; }
.step-row { min-height: 114px; display: grid; grid-template-columns: 116px 1fr; gap: 28px; align-items: center; padding: 22px 30px; background: color-mix(in srgb, var(--card) 88%, var(--bg)); border: 2px solid color-mix(in srgb, var(--grid) 72%, transparent); border-radius: var(--card-radius); box-shadow: var(--deck-shadow); }
.step-row span { display: grid; place-items: center; width: 78px; height: 78px; background: var(--text); color: var(--bg); font-size: 28px; font-weight: 880; }
.step-row p { margin: 0; color: var(--text); font-size: 34px; line-height: 1.22; font-weight: 680; }
.summary-panel { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; max-width: 1460px; }
.summary-row { min-height: 128px; display: grid; grid-template-columns: 78px 1fr; gap: 24px; align-items: center; padding: 24px 28px; background: color-mix(in srgb, var(--card) 90%, var(--bg)); border: 2px solid color-mix(in srgb, var(--grid) 74%, transparent); border-radius: var(--card-radius); box-shadow: var(--deck-shadow); }
.summary-row span { display: grid; place-items: center; width: 58px; height: 58px; color: var(--accent); border: 2px solid color-mix(in srgb, var(--accent) 72%, var(--grid)); font-size: 22px; font-weight: 860; }
.summary-row p { margin: 0; color: var(--text); font-size: 31px; line-height: 1.22; font-weight: 700; }
.comparison-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 34px; }
.comparison-card { min-height: 570px; padding: 42px; background: var(--card); border-top: 10px solid var(--accent); border-radius: var(--card-radius); box-shadow: var(--deck-shadow); }
.comparison-card:nth-child(2n) { border-top-color: var(--accent-2); }
.comparison-card h3 { font-size: 38px; margin-bottom: 32px; }
.comparison-card p { padding: 22px 0; border-top: 1px solid var(--grid); font-size: 28px; line-height: 1.26; color: var(--muted); }
.chart-panel, .table-wrap { padding: 34px; background: var(--card); border: 2px solid var(--grid); border-radius: var(--card-radius); box-shadow: var(--deck-shadow); }
.chart-row { display: grid; grid-template-columns: 260px 1fr 130px; gap: 28px; align-items: center; min-height: 76px; }
.chart-label, .chart-value { font-size: 28px; font-weight: 760; }
.chart-value { text-align: right; color: var(--accent); }
.chart-track { height: 32px; background: color-mix(in srgb, var(--grid) 52%, transparent); overflow: hidden; }
.chart-fill { height: 100%; width: var(--bar); background: linear-gradient(90deg, var(--bar-color), var(--accent-2)); transform-origin: left center; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { padding: 24px 26px; border: 2px solid var(--grid); font-size: 27px; line-height: 1.2; text-align: left; }
th { background: var(--accent); color: var(--on-accent); font-weight: 820; }
td { background: color-mix(in srgb, var(--card) 92%, var(--bg)); color: var(--text); }
.quote-block { max-width: 1320px; margin: 92px auto 0; padding: 62px 70px; background: var(--card); border-left: 18px solid var(--accent); border-radius: var(--card-radius); box-shadow: var(--deck-shadow); }
blockquote { margin: 0; font-family: var(--font-heading); font-size: 62px; line-height: 1.16; }
figcaption { margin-top: 34px; color: var(--muted); font-size: 28px; }
.visual-split { display: grid; grid-template-columns: 1.15fr .85fr; gap: 38px; min-height: 620px; }
.image-placeholder { position: relative; display: grid; place-items: center; min-height: 620px; overflow: hidden; background: linear-gradient(135deg, var(--section-bg), var(--accent)); border-radius: var(--card-radius); color: var(--section-text); }
.image-placeholder div { position: absolute; inset: 42px; border: 2px solid color-mix(in srgb, var(--section-text) 46%, transparent); background-image: linear-gradient(90deg, color-mix(in srgb, var(--section-text) 16%, transparent) 1px, transparent 1px), linear-gradient(0deg, color-mix(in srgb, var(--section-text) 16%, transparent) 1px, transparent 1px); background-size: 70px 70px; }
.image-placeholder span { position: relative; font-size: 42px; font-weight: 860; text-transform: uppercase; }
.caption-panel { display: flex; align-items: flex-end; padding: 42px; background: var(--card); border: 2px solid var(--grid); border-radius: var(--card-radius); }
.caption-panel p { color: var(--muted); font-size: 34px; line-height: 1.3; }
.slide-section { display: grid; place-items: center; padding: 120px; background: var(--section-bg); color: var(--section-text); }
.slide-section::before { background: linear-gradient(135deg, color-mix(in srgb, var(--accent-2) 20%, transparent), transparent 56%); }
.section-mark { position: absolute; left: 86px; top: 68px; color: color-mix(in srgb, var(--section-text) 58%, transparent); font-size: 44px; font-weight: 850; }
.slide-section h2 { max-width: 1220px; font-family: var(--font-heading); font-size: clamp(76px, 7vw, 136px); line-height: .98; text-align: center; }
.section-line { width: 520px; height: 8px; background: linear-gradient(90deg, var(--accent), var(--accent-2)); }
html[data-sourceweft-layout="blueprint"] .sw-slide::before { background: linear-gradient(90deg, color-mix(in srgb, var(--grid) 34%, transparent) 1px, transparent 1px), linear-gradient(0deg, color-mix(in srgb, var(--grid) 34%, transparent) 1px, transparent 1px), linear-gradient(135deg, color-mix(in srgb, var(--accent) 10%, transparent), transparent 58%); background-size: 72px 72px, 72px 72px, auto; }
html[data-sourceweft-layout="blueprint"] .bullet-card span { border-radius: 0; }
html[data-sourceweft-layout="blueprint"] .comparison-card { border-top-width: 2px; border-left: 12px solid var(--accent); }
html[data-sourceweft-layout="editorial"] .title-frame { max-width: 1160px; margin-top: 74px; }
html[data-sourceweft-layout="editorial"] .bullet-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
html[data-sourceweft-layout="minimal"] .sw-slide::after { width: 96px; opacity: .4; }
html[data-sourceweft-layout="minimal"] .bullet-card, html[data-sourceweft-layout="minimal"] .comparison-card, html[data-sourceweft-layout="minimal"] .chart-panel, html[data-sourceweft-layout="minimal"] .table-wrap { box-shadow: none; }
html[data-sourceweft-layout="poster"] .slide-content h2 { max-width: 1500px; font-size: 82px; line-height: .94; }
html[data-sourceweft-layout="poster"] .bullet-grid { grid-template-columns: 1fr; gap: 18px; }
html[data-sourceweft-layout="poster"] .bullet-card { min-height: 116px; grid-template-columns: 92px 1fr; align-items: center; border-width: 0 0 2px; background: transparent; }
html[data-sourceweft-layout="poster"] .bullet-card p { font-size: 40px; font-weight: 800; line-height: 1.08; }
html[data-sourceweft-family="swiss"] .sw-slide { background: var(--bg); }
html[data-sourceweft-family="swiss"] .sw-slide::before { background: linear-gradient(90deg, color-mix(in srgb, var(--grid) 62%, transparent) 1px, transparent 1px), linear-gradient(0deg, color-mix(in srgb, var(--grid) 48%, transparent) 1px, transparent 1px); background-size: 96px 96px; }
html[data-sourceweft-family="swiss"] .sw-slide::after { right: 92px; bottom: 74px; width: 180px; height: 1px; background: var(--accent); }
html[data-sourceweft-family="swiss"] .slide-topline { top: 64px; color: var(--text); font-size: 18px; letter-spacing: .12em; }
html[data-sourceweft-family="swiss"] h1, html[data-sourceweft-family="swiss"] h2 { font-family: var(--font-body); font-weight: 400; letter-spacing: 0; }
html[data-sourceweft-family="swiss"] .slide-content h2 { max-width: 1180px; font-size: 74px; line-height: .96; font-weight: 400; }
html[data-sourceweft-family="swiss"] .bullet-card, html[data-sourceweft-family="swiss"] .comparison-card, html[data-sourceweft-family="swiss"] .chart-panel, html[data-sourceweft-family="swiss"] .table-wrap, html[data-sourceweft-family="swiss"] .quote-block, html[data-sourceweft-family="swiss"] .caption-panel { border-radius: 0; box-shadow: none; }
html[data-sourceweft-family="swiss"] .bullet-card { border-width: 1px 0 0; background: transparent; }
html[data-sourceweft-family="swiss"] .bullet-card span { border-radius: 0; background: var(--text); color: var(--bg); }
html[data-sourceweft-family="swiss"] .title-rail span { background: var(--accent); }
html[data-sourceweft-family="education"] .sw-slide::before { background: radial-gradient(circle at 12% 16%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 24%), linear-gradient(0deg, transparent 94%, color-mix(in srgb, var(--grid) 30%, transparent) 95%); background-size: auto, 100% 54px; }
html[data-sourceweft-family="education"] .slide-topline { color: color-mix(in srgb, var(--text) 58%, var(--accent)); }
html[data-sourceweft-family="education"] .slide-content h2 { max-width: 1260px; font-size: 64px; line-height: 1.06; }
html[data-sourceweft-family="education"] .bullet-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; }
html[data-sourceweft-family="education"] .bullet-card { border: 2px dashed color-mix(in srgb, var(--accent) 38%, var(--grid)); background: color-mix(in srgb, var(--card) 84%, var(--bg)); }
html[data-sourceweft-family="education"] .bullet-card span { border-radius: 999px; font-family: var(--font-heading); background: color-mix(in srgb, var(--accent) 88%, var(--bg)); }
html[data-sourceweft-family="education"] [data-layout="education-concept-map"] .bullet-grid { grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); }
html[data-sourceweft-family="education"] [data-layout="education-paragraph"] .paragraph-panel { border-style: solid; }
html[data-sourceweft-family="education"] [data-layout="education-step-board"] .bullet-grid { grid-template-columns: 1fr; }
html[data-sourceweft-family="education"] [data-layout="education-step-board"] .bullet-card { min-height: 104px; grid-template-columns: 90px 1fr; }
html[data-sourceweft-family="education"] [data-layout="education-step-board"] .step-row span,
html[data-sourceweft-family="education"] [data-layout="education-practice"] .step-row span { border-radius: 999px; background: color-mix(in srgb, var(--accent) 88%, var(--bg)); color: var(--on-accent); }
html[data-sourceweft-family="education"] [data-layout="education-practice"] .bullet-card { background: color-mix(in srgb, var(--accent) 10%, var(--card)); }
html[data-sourceweft-family="magazine"] .sw-slide::before, html[data-sourceweft-family="editorial"] .sw-slide::before { background: linear-gradient(115deg, color-mix(in srgb, var(--accent) 13%, transparent), transparent 46%), radial-gradient(circle at 82% 18%, color-mix(in srgb, var(--accent-2) 12%, transparent), transparent 28%); }
html[data-sourceweft-family="magazine"] .slide-content h2, html[data-sourceweft-family="editorial"] .slide-content h2 { max-width: 1200px; font-size: 66px; line-height: .98; }
html[data-sourceweft-family="magazine"] .bullet-grid, html[data-sourceweft-family="editorial"] .bullet-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
html[data-sourceweft-family="blueprint"] .sw-slide::before { background: linear-gradient(90deg, color-mix(in srgb, var(--grid) 48%, transparent) 1px, transparent 1px), linear-gradient(0deg, color-mix(in srgb, var(--grid) 48%, transparent) 1px, transparent 1px), linear-gradient(135deg, color-mix(in srgb, var(--accent) 12%, transparent), transparent 58%); background-size: 64px 64px, 64px 64px, auto; }
html[data-sourceweft-family="blueprint"] .bullet-card, html[data-sourceweft-family="blueprint"] .comparison-card, html[data-sourceweft-family="blueprint"] .chart-panel, html[data-sourceweft-family="blueprint"] .table-wrap { border-radius: 2px; box-shadow: 10px 14px 0 rgba(8, 12, 18, .14); }
html[data-sourceweft-family="data-report"] .slide-content { padding-top: 118px; }
html[data-sourceweft-family="data-report"] .slide-content h2 { font-size: 52px; }
html[data-sourceweft-family="data-report"] .bullet-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
html[data-sourceweft-family="data-report"] .bullet-card { grid-template-columns: 1fr; gap: 14px; min-height: 210px; }
html[data-sourceweft-family="data-report"] .bullet-card span { width: 54px; height: 54px; }
[data-anim] { opacity: 0; transform: translateY(28px); transition: opacity 560ms ease, transform 620ms ease; transition-delay: calc(var(--i, 0) * 70ms); }
.is-active [data-anim] { opacity: 1; transform: translateY(0); }
.is-active .chart-fill { animation: grow 720ms ease both; }
@keyframes grow { from { transform: scaleX(.05); } to { transform: scaleX(1); } }
.deck-controls { position: fixed; left: 50%; bottom: 8px; z-index: 20; display: flex; flex-wrap: nowrap; justify-content: center; align-items: center; gap: 6px; width: min(320px, calc(100% - 28px)); height: 34px; padding: 0 8px; overflow: hidden; transform: translateX(-50%); border: 1px solid rgba(255,255,255,.16); border-radius: 999px; background: rgba(8, 12, 18, .74); color: #f8fafc; font-family: var(--font-body); box-shadow: 0 18px 46px rgba(0,0,0,.24); backdrop-filter: blur(16px); }
.deck-controls button { flex: 0 0 auto; min-width: 28px; max-width: 48px; height: 26px; padding: 0 8px; overflow: hidden; border: 1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.08); color: inherit; font: inherit; text-align: center; white-space: nowrap; cursor: pointer; }
.deck-controls button:hover, .deck-controls button.is-active { background: rgba(255,255,255,.24); }
.deck-controls .nav { min-width: 42px; width: 42px; height: 26px; border-radius: 999px; font-size: 0; }
.deck-controls .nav::before { font-size: 16px; line-height: 1; }
.deck-controls [data-prev]::before { content: "\\2039"; }
.deck-controls [data-next]::before { content: "\\203A"; }
.deck-count { flex: 1; min-width: 68px; overflow: hidden; color: rgba(248,250,252,.92); font-size: 12px; font-weight: 760; line-height: 1; text-align: center; white-space: nowrap; font-variant-numeric: tabular-nums; }
body.sw-export { overflow: visible; background: #fff; }
body.sw-export .deck-viewport { position: static; display: block; padding: 0; background: #fff; }
body.sw-export .deck-shell { transform: none !important; width: auto; height: auto; }
body.sw-export .sw-slide { position: relative; visibility: visible; opacity: 1; transform: none; margin: 0 0 40px; }
body.sw-export *, body.sw-export *::before, body.sw-export *::after { animation: none !important; transition: none !important; }
body.sw-export [data-anim], body.sw-export .chart-fill { opacity: 1; transform: none; animation: none !important; transition: none !important; }
body.sw-export .deck-controls { display: none; }
</style>
</head>
<body>
<main class="deck-viewport">
  <div class="deck-shell" data-slide-width="${size.width}" data-slide-height="${size.height}" data-aspect-ratio="${source.design.aspectRatio}">
    ${slidesHtml}
  </div>
</main>
<nav class="deck-controls" aria-label="Slide navigation">
  <button class="nav" data-prev type="button">Prev</button>
  <span class="deck-count" data-count>1 / ${source.slides.length}</span>
  <button class="nav" data-next type="button">Next</button>
</nav>
<script>
(() => {
  const shell = document.querySelector(".deck-shell");
  const viewport = document.querySelector(".deck-viewport");
  const slides = Array.from(document.querySelectorAll(".sw-slide"));
  const count = document.querySelector("[data-count]");
  let current = 0;
  function fit() {
    if (!shell || !viewport || document.body.classList.contains("sw-export")) return;
    const w = Number(shell.dataset.slideWidth || 1920);
    const h = Number(shell.dataset.slideHeight || 1080);
    const rect = viewport.getBoundingClientRect();
    const scale = Math.min(rect.width / w, rect.height / h);
    const safeScale = Math.max(0.1, scale);
    shell.style.left = Math.max(0, (rect.width - w * safeScale) / 2) + "px";
    shell.style.top = Math.max(0, (rect.height - h * safeScale) / 2) + "px";
    shell.style.transformOrigin = "top left";
    shell.style.transform = "scale(" + safeScale + ")";
    shell.style.width = w + "px";
    shell.style.height = h + "px";
  }
  function go(index) {
    current = Math.max(0, Math.min(slides.length - 1, index));
    slides.forEach((slide, slideIndex) => slide.classList.toggle("is-active", slideIndex === current));
    if (count) count.textContent = (current + 1) + " / " + slides.length;
  }
  document.querySelector("[data-prev]")?.addEventListener("click", () => go(current - 1));
  document.querySelector("[data-next]")?.addEventListener("click", () => go(current + 1));
  window.addEventListener("resize", fit);
  window.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight" || event.key === "PageDown") go(current + 1);
    if (event.key === "ArrowLeft" || event.key === "PageUp") go(current - 1);
  });
  window.SourceWeftDeck = { fit, go, next: () => go(current + 1), previous: () => go(current - 1), total: slides.length };
  fit();
  go(0);
})();
</script>
</body>
</html>`;

  return Buffer.from(html, "utf8");
}

function formatToolResult(input: {
  artifactId: string;
  artifactUrl: string;
  editable: boolean;
  fileName: string;
  generationMode: GenerationMode;
  internalGenerationMode?: InternalPptxGenerationMode;
  legacyGenerationMode?: GenerationMode;
  htmlUrl?: string;
  pptxUrl?: string;
  previewRenderer: "html_iframe" | "pptxviewjs";
  versionId: string;
  title: string;
  sourceJsonUrl?: string;
  qaSummary: string;
  slideCount: number;
  warnings: string[];
  renderMetadata?: Record<string, unknown>;
  qaReportSummary?: Record<string, unknown>;
  composerObservabilityMetadata?: Record<string, unknown>;
}) {
  return {
    type: "presentation_artifact_result",
    artifact_id: input.artifactId,
    artifact_url: input.artifactUrl,
    content:
      `${input.generationMode === "visual_html" ? "Visual deck" : "PPTX"} artifact created: ${input.fileName}\n` +
      "The application will display a download card automatically.",
    editable: input.editable,
    file_name: input.fileName,
    generation_mode: input.generationMode,
    ...(input.internalGenerationMode
      ? { internal_generation_mode: input.internalGenerationMode }
      : {}),
    ...(input.legacyGenerationMode
      ? { legacy_generation_mode: input.legacyGenerationMode }
      : {}),
    preview_renderer: input.previewRenderer,
    qa_summary: input.qaSummary,
    slide_count: input.slideCount,
    title: input.title,
    version_id: input.versionId,
    warnings: input.warnings,
    ...(input.htmlUrl ? { html_url: input.htmlUrl } : {}),
    ...(input.pptxUrl ? { pptx_url: input.pptxUrl } : {}),
    ...(input.sourceJsonUrl ? { source_json_url: input.sourceJsonUrl } : {}),
    ...(input.renderMetadata ? { render_metadata: input.renderMetadata } : {}),
    ...(input.qaReportSummary ? { qa_report_summary: input.qaReportSummary } : {}),
    ...(input.composerObservabilityMetadata
      ? { composer_observability_metadata: input.composerObservabilityMetadata }
      : {}),
  };
}


function jsonHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function withHexPrefix(value: string | undefined, fallback: string) {
  const text = (value ?? "").trim().replace(/^#/, "");
  return /^[0-9A-Fa-f]{6}$/.test(text) ? `#${text.toUpperCase()}` : fallback;
}

function composerRoleForSlide(slide: SlideSpec, index: number): PresentationSourceV1["slides"][number]["role"] {
  if (index === 0 || slide.kind === "title") return "cover";
  if (slide.kind === "section") return "section";
  if (slide.kind === "closing") return "closing";
  if (slide.kind === "chart" || slide.kind === "table") return "data";
  if (slide.kind === "comparison") return "comparison";
  return "content";
}

function composerLayoutForSlide(slide: SlideSpec, role: PresentationSourceV1["slides"][number]["role"], body: string[]): PresentationSourceV1["slides"][number]["layoutSpec"] {
  if (role === "cover") {
    return {
      kind: "locked",
      name: "tool-cover-hero",
      intent: "Cover slide with title, headline, and proof chips",
      requiredSlots: ["title", "headline"],
      regions: [
        { id: "title", slot: "title", x: 0.08, y: 0.16, width: 0.72, height: 0.18, zIndex: 1 },
        { id: "headline", slot: "headline", x: 0.08, y: 0.38, width: 0.74, height: 0.16, zIndex: 1 },
        { id: "proof", slot: "proof-chips", x: 0.08, y: 0.66, width: 0.78, height: 0.14, zIndex: 1 },
      ],
      balance: "left-weighted",
    };
  }
  if (role === "comparison" && body.length >= 2) {
    return {
      kind: "parametric",
      name: "tool-comparison-columns",
      intent: "Compare key alternatives with balanced columns",
      requiredSlots: ["title", "column-a", "column-b"],
      regions: [
        { id: "title", slot: "title", x: 0.08, y: 0.08, width: 0.84, height: 0.14, zIndex: 1 },
        { id: "column-a", slot: "column-a", x: 0.1, y: 0.32, width: 0.36, height: 0.42, zIndex: 1 },
        { id: "column-b", slot: "column-b", x: 0.54, y: 0.32, width: 0.36, height: 0.42, zIndex: 1 },
      ],
      balance: "grid",
    };
  }
  if (role === "content" && body.length >= 3 && body.length <= 5) {
    return {
      kind: "parametric",
      name: "tool-step-grid",
      intent: "Show concise body points as editable step cards",
      requiredSlots: ["title", ...body.slice(0, 5).map((_, index) => `step-${index + 1}`)],
      regions: [
        { id: "title", slot: "title", x: 0.08, y: 0.08, width: 0.84, height: 0.14, zIndex: 1 },
        ...body.slice(0, 5).map((_, index) => ({
          id: `step-${index + 1}`,
          slot: `step-${index + 1}`,
          x: 0.08 + index * (0.84 / body.slice(0, 5).length),
          y: 0.34,
          width: Math.max(0.14, 0.72 / body.slice(0, 5).length),
          height: 0.32,
          zIndex: 1,
        })),
      ],
      balance: "grid",
    };
  }
  return {
    kind: role === "section" || role === "closing" ? "locked" : "generated",
    name: role === "section" ? "tool-section-statement" : role === "closing" ? "tool-closing-callout" : "tool-two-column-body",
    intent: slide.intent ?? "Render slide title and authored body copy as native editable text",
    requiredSlots: role === "closing" ? ["title", "headline"] : body.length > 0 ? ["title", "column-a", "column-b"] : ["title", "column-a", "column-b"],
    regions: role === "closing"
      ? [
          { id: "title", slot: "title", x: 0.1, y: 0.14, width: 0.8, height: 0.16, zIndex: 1 },
          { id: "headline", slot: "headline", x: 0.16, y: 0.38, width: 0.68, height: 0.16, zIndex: 1 },
          { id: "next-step", slot: "next-step", x: 0.22, y: 0.62, width: 0.56, height: 0.16, zIndex: 1 },
        ]
      : [
          { id: "title", slot: "title", x: 0.08, y: 0.08, width: 0.84, height: 0.12, zIndex: 1 },
          { id: "column-a", slot: "column-a", x: 0.08, y: 0.3, width: 0.38, height: 0.44, zIndex: 1 },
          { id: "column-b", slot: "column-b", x: 0.54, y: 0.3, width: 0.38, height: 0.44, zIndex: 1 },
        ],
    balance: role === "section" || role === "closing" ? "centered" : "grid",
  };
}

function deckSourceToComposerSource(source: DeckSource): PresentationSourceV1 {
  const theme = themeFor(source);
  const keyPoints = source.slides.flatMap((slide) => [slideHeading(slide), ...bodyToBullets(slide.body)]).filter(Boolean).slice(0, 24);
  const narrativeArc = source.deckSpec.narrativeArc.length > 0 ? source.deckSpec.narrativeArc : source.slides.map((slide) => slideHeading(slide)).slice(0, 12);
  const designDensity = source.design.visualSystem?.density ?? "balanced";
  return {
    schemaVersion: "pptx-composer.v1",
    requirementAnalysis: {
      audience: source.brief?.slice(0, 240) || "SourceWeft presentation audience",
      objective: `Create a native editable PPTX deck titled ${source.title}`,
      primaryMessage: source.deckSpec.cover.subtitle ?? source.slides[1]?.claim ?? source.title,
      constraints: ["Native editable PPTX", "No hidden prompts or provider secrets", "Preserve authored slide content"],
      successCriteria: ["PPTX file is downloadable", "Source JSON supports regeneration", "QA metadata is persisted"],
      language: source.design.language ?? "auto",
    },
    contentBrief: {
      title: source.title,
      ...(source.deckSpec.cover.subtitle ? { subtitle: source.deckSpec.cover.subtitle } : {}),
      narrativeArc: narrativeArc.length > 0 ? narrativeArc : [source.title],
      keyPoints: keyPoints.length > 0 ? keyPoints : [source.title],
      ...(source.brief ? { sourceSummary: source.brief.slice(0, 2000) } : {}),
    },
    deckStrategy: {
      deckTitle: source.title,
      audienceTakeaway: source.deckSpec.cover.subtitle ?? source.slides.at(-1)?.claim ?? source.title,
      storyBeats: narrativeArc.length > 0 ? narrativeArc.slice(0, 16) : [source.title],
      slideCountTarget: source.slides.length,
      pacing: source.slides.length > 8 ? "direct" : "balanced",
    },
    designSystem: {
      name: theme.name,
      aspectRatio: source.design.aspectRatio,
      language: source.design.language ?? "auto",
      palette: {
        background: withHexPrefix(theme.background, "#F8FAFC"),
        foreground: withHexPrefix(theme.text, "#0F172A"),
        accent: withHexPrefix(theme.accent, "#2563EB"),
        muted: withHexPrefix(theme.muted, "#64748B"),
        surface: withHexPrefix(theme.card, "#FFFFFF"),
      },
      typography: {
        family: theme.bodyFont,
        scale: source.design.visualSystem?.typography?.some((entry) => /display|expressive|large/i.test(entry)) ? "expressive" : "standard",
      },
      density: designDensity,
      layoutPrinciples: source.design.visualSystem?.layoutPrinciples?.slice(0, 10) ?? ["One primary claim per slide", "PowerPoint-native editable objects"],
      ...(source.design.customBrief ? { brandNotes: source.design.customBrief.slice(0, 800) } : {}),
    },
    assetPlan: {
      items: [],
      ...(source.assets.imageArtifactIds?.length ? { notes: `Referenced image artifacts: ${source.assets.imageArtifactIds.slice(0, 8).join(", ")}` } : {}),
    },
    slides: source.slides.map((slide, index) => {
      const role = composerRoleForSlide(slide, index);
      const body = composerBodyForSlide(slide, source, role).slice(0, 8);
      return {
        id: `slide-${index + 1}`,
        role,
        title: role === "cover" ? source.deckSpec.cover.title : slideHeading(slide),
        ...(slide.caption
          ? { headline: slide.caption }
          : index === 0 && source.deckSpec.cover.subtitle
            ? { headline: source.deckSpec.cover.subtitle }
            : role === "cover" && body[0]
              ? { headline: body[0] }
            : role === "closing"
              ? { headline: slide.intent ?? body[0] ?? slide.claim }
              : slide.title && slide.title !== slide.claim
                ? { headline: slide.claim }
                : {}),
        body,
        ...(slide.notes ? { speakerNotes: slide.notes } : {}),
        ...(slide.intent ? { visualIntent: slide.intent } : {}),
        layoutSpec: composerLayoutForSlide(slide, role, body),
        assetRefs: [],
      };
    }),
    qaReport: { status: "not_run", issues: [] },
    extensions: {
      sourceweftGenerationMode: "high_quality_editable_pptx",
      legacyGenerationMode: source.template.usage,
    },
  };
}

function composerBodyForSlide(slide: SlideSpec, source: DeckSource, role: PresentationSourceV1["slides"][number]["role"]): string[] {
  const body = bodyToBullets(slide.body);
  if (role === "cover") {
    return [source.deckSpec.cover.kicker, ...body].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }
  if (slide.kind === "comparison") {
    return normalizeComparisonGroups(slide).flatMap((group) => [group.title, ...group.bullets]).filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }
  if (slide.kind === "table") {
    return normalizeRows(slide.body).map((row) => row.join(" | ")).filter((entry) => entry.length > 0);
  }
  if (slide.kind === "chart") {
    return normalizeChartData(slide.body).map((item) => `${item.name}: ${item.value}`);
  }
  return body;
}

function redactSecretLikeMetadata(value: unknown): unknown {
  if (typeof value === "string") {
    return /sk-|Bearer\s+|api_key/i.test(value) ? "[REDACTED]" : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretLikeMetadata(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        /api_key/i.test(key) ? "[REDACTED]" : redactSecretLikeMetadata(entry),
      ]),
    );
  }
  return value;
}

function summarizeQaReport(report: QaReport) {
  const issueCounts = report.issues.reduce<Record<string, number>>((counts, issue) => {
    counts[issue.severity] = (counts[issue.severity] ?? 0) + 1;
    return counts;
  }, {});
  return {
    status: report.status,
    issueCount: report.issues.length,
    issueCounts,
    ...(report.checkedAtIso ? { checkedAtIso: report.checkedAtIso } : {}),
  };
}

function summarizeComposerMetadata(input: {
  renderMetadata?: RenderMetadata;
  qaReport?: QaReport;
  renderQaReport?: QaReport;
}) {
  return {
    ...(input.renderMetadata
      ? {
          renderMetadata: redactSecretLikeMetadata(input.renderMetadata) as Record<string, unknown>,
        }
      : {}),
    ...(input.qaReport ? { qaReport: redactSecretLikeMetadata(input.qaReport) as Record<string, unknown> } : {}),
    ...(input.renderQaReport ? { renderQaReport: redactSecretLikeMetadata(input.renderQaReport) as Record<string, unknown> } : {}),
    ...(input.qaReport ? { qaSummary: summarizeQaReport(input.qaReport) } : {}),
    ...(input.renderQaReport ? { renderQaSummary: summarizeQaReport(input.renderQaReport) } : {}),
  };
}

function qaFailureCount(report: Record<string, unknown> | undefined) {
  const issues = Array.isArray(report?.issues) ? report.issues : [];
  const errorCount = issues.filter(
    (issue) =>
      issue &&
      typeof issue === "object" &&
      (issue as { severity?: unknown }).severity === "error",
  ).length;
  return report?.status === "failed" && errorCount === 0 ? 1 : errorCount;
}

function warningCodeFrom(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.split(":", 1)[0]?.trim() || undefined;
}

function qaIssueCodes(report: Record<string, unknown> | undefined) {
  const issues = Array.isArray(report?.issues) ? report.issues : [];
  return issues
    .map((issue) =>
      issue && typeof issue === "object"
        ? (issue as { code?: unknown }).code
        : undefined,
    )
    .filter((code): code is string => typeof code === "string" && code.length > 0);
}

function buildComposerObservabilityMetadata(input: {
  artifactId?: string;
  artifactRefs?: Record<string, unknown>;
  composerSource: PresentationSourceV1;
  generationId?: string;
  metadata: ReturnType<typeof summarizeComposerMetadata>;
  renderDurationMs?: number;
  repairAttemptCount?: number;
  warnings?: string[];
}) {
  const renderMetadata = input.metadata.renderMetadata;
  const qaReport = input.metadata.qaReport;
  const renderQaReport = input.metadata.renderQaReport;
  const layoutIds = input.composerSource.slides.map((slide) => slide.layoutSpec.name);
  const warningCodes = Array.from(
    new Set(
      (redactSecretLikeMetadata(
        [
          ...(input.warnings ?? []).map(warningCodeFrom),
          ...(Array.isArray(renderMetadata?.warnings)
            ? renderMetadata.warnings.map(warningCodeFrom)
            : []),
          ...qaIssueCodes(qaReport),
          ...qaIssueCodes(renderQaReport),
        ].filter((code): code is string => typeof code === "string" && code.length > 0),
      ) as string[]).filter((code) => code.length > 0),
    ),
  );
  const preRenderQaFailureCount = qaFailureCount(qaReport);
  const renderQaFailureCount = qaFailureCount(renderQaReport);
  return redactSecretLikeMetadata({
    schemaVersion: "pptx-composer.observability.v1",
    ...(input.generationId ? { generationId: input.generationId } : {}),
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
    sourceSchemaVersion: input.composerSource.schemaVersion,
    selectedVisualSystem: {
      designName: input.composerSource.designSystem.name,
      density: input.composerSource.designSystem.density,
      aspectRatio: input.composerSource.designSystem.aspectRatio,
      language: input.composerSource.designSystem.language,
    },
    layoutIds,
    qaFailureCounts: {
      preRender: preRenderQaFailureCount,
      render: renderQaFailureCount,
      total: preRenderQaFailureCount + renderQaFailureCount,
    },
    repairAttemptCount: input.repairAttemptCount ?? 0,
    ...(typeof input.renderDurationMs === "number"
      ? { renderDurationMs: input.renderDurationMs }
      : {}),
    ...(input.artifactRefs ? { artifactRefs: input.artifactRefs } : {}),
    warningCodes,
  }) as Record<string, unknown>;
}

async function buildComposerPptxArtifact(
  source: DeckSource,
  options: { failOnQaErrors?: boolean; failOnRenderQaErrors?: boolean } = {},
) {
  const composerSource = deckSourceToComposerSource(source);
  const composePresentationSource = createComposePresentationSourceUseCase({
    renderer: new PptxGenJsRendererAdapter(),
    qaValidator: validatePreRenderQa,
    renderQaValidator: validateRenderQa,
  });
  const renderStartedAt = Date.now();
  const result = await composePresentationSource({
    source: composerSource,
    renderOptions: {
      includeSpeakerNotes: true,
      locale: source.design.resolvedLanguage,
      sourceHash: jsonHash(composerSource),
    },
    failOnQaErrors: options.failOnQaErrors ?? true,
    failOnRenderQaErrors: options.failOnRenderQaErrors ?? true,
  });
  return {
    artifactBuffer: result.pptxBuffer,
    composerSource: result.source,
    metadata: summarizeComposerMetadata({
      renderMetadata: result.renderMetadata,
      qaReport: result.qaReport,
      renderQaReport: result.renderQaReport,
    }),
    renderDurationMs: Date.now() - renderStartedAt,
  };
}

function formatInputRequiredResult(input: { reason?: string; title: string; warnings?: string[] }) {
  return {
    type: "presentation_artifact_input_required",
    status: "needs_content",
    title: input.title,
    content:
      input.reason ??
      "generate_pptx needs explicit authored deck content before it can create a slides artifact. Retry with content.cover and a slides array containing the final visible slide specs: kind, claim or title, and body/caption/table/chart data where needed.",
    required_fields: ["content.cover", "slides"],
    ...(input.warnings?.length ? { warnings: input.warnings } : {}),
  };
}

function formatComposerQaInputRequiredResult(input: {
  error: PresentationComposerQaError;
  title: string;
}) {
  const qaSummary = summarizeQaReport(input.error.qaReport);
  const phaseLabel = input.error.phase === "source" ? "source" : "render";
  const warnings = input.error.qaReport.issues.slice(0, 12).map((issue) => {
    const location = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    return `${issue.code}${location}: ${issue.message}`;
  });

  return {
    ...formatInputRequiredResult({
      title: input.title,
      reason: `generate_pptx blocked saving because the presentation ${phaseLabel} QA failed. Retry with complete visible slide content and safe registered layouts that satisfy every required slot.`,
      warnings,
    }),
    composer_qa_phase: input.error.phase,
    qa_report_summary: qaSummary,
  };
}

export function createGeneratePptxTool(input: {
  defaultDesign?: GeneratePptxArgs["design"];
  defaultGenerationMode?: GeneratePptxArgs["generationMode"];
  defaultOutput?: GeneratePptxArgs["output"];
  defaultRendering?: GeneratePptxArgs["rendering"];
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  userMessageId: string;
}) {
  return tool(
    async (rawArgs: GeneratePptxArgs, runtime: ToolRuntime) => {
      const args = parseGeneratePptxArgs(rawArgs);
      const generationRoute = normalizePptxGenerationRoute({
        defaultGenerationMode: input.defaultGenerationMode,
        generationMode: args.generationMode,
      });
      const generationMode = generationRoute.artifactGenerationMode;
      const effectiveArgs: GeneratePptxArgs = {
        ...args,
        generationMode,
        design: {
          ...(input.defaultDesign ?? {}),
          ...(args.design ?? {}),
        },
        output: {
          ...(input.defaultOutput ?? {}),
          ...(args.output ?? {}),
        },
        rendering: {
          ...(input.defaultRendering ?? {}),
          ...(args.rendering ?? {}),
        },
      };
      const title = args.title.trim();
      if (!hasSufficientAuthoredDeckContent(effectiveArgs)) {
        return formatInputRequiredResult({ title });
      }
      const toolCallId = resolveToolRuntimeCallId(runtime);
      const emitProgress = (
        stage: "planning" | "generating" | "saving" | "ready",
        metadata?: Record<string, unknown>,
      ) => {
        if (!toolCallId) {
          return;
        }
        runtime.writer?.({
          type: GENERATED_PPTX_PROGRESS_EVENT_TYPE,
          toolCallId,
          tool: AGENT_TOOL_NAMES.generatePptx,
          stage,
          title,
          ...metadata,
        });
      };

      const source = normalizeDeckSource(effectiveArgs);
      emitProgress("planning", {
        generationMode,
        internalGenerationMode: generationRoute.internalGenerationMode,
        legacyGenerationMode: generationRoute.legacyGenerationMode,
        mode: effectiveArgs.mode,
        narrativeArcCount: source.deckSpec.narrativeArc.length,
        slideCount: source.slides.length,
      });
      if (generationMode === "visual_html") {
        const { blockingWarnings } = buildVisualDeckBlockingQaWarnings(source);
        if (blockingWarnings.length > 0) {
          return formatInputRequiredResult({
            title,
            reason:
              "generate_pptx blocked saving because the visual deck failed layout QA. Retry with safer registered layouts and complete visible content slots.",
            warnings: blockingWarnings,
          });
        }
      }
      const warnings = [
        ...generationRoute.warnings,
        ...buildQaWarnings({
          generationMode,
          source,
          output: effectiveArgs.output,
        }),
      ];
      const visualMetadata =
        generationMode === "visual_html"
          ? extractVisualDeckMetadata(source)
          : undefined;
      if (warnings.length > 0) {
        logger.warn("generate_pptx completed v1 QA with warnings", {
          artifactTitle: title,
          generationMode,
          internalGenerationMode: generationRoute.internalGenerationMode,
          legacyGenerationMode: generationRoute.legacyGenerationMode,
          mode: effectiveArgs.mode,
          slideCount: source.slides.length,
          stylePreset: source.design.stylePreset,
          aspectRatio: source.design.aspectRatio,
          language: source.design.language ?? "auto",
          resolvedLanguage: source.design.resolvedLanguage,
          customBrief: source.design.customBrief,
          visualSystem: source.design.visualSystem,
          templateUsage: source.template.usage,
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          userId: input.userId,
          userMessageId: input.userMessageId,
          toolCallId,
          warnings,
        });
      }

      emitProgress("generating", { slideCount: source.slides.length });
      let composerArtifact: Awaited<ReturnType<typeof buildComposerPptxArtifact>> | undefined;
      if (generationMode === "editable_native") {
        try {
          composerArtifact = await buildComposerPptxArtifact(source);
        } catch (error) {
          if (error instanceof PresentationComposerQaError) {
            return formatComposerQaInputRequiredResult({ error, title });
          }
          throw error;
        }
      }
      const artifactBuffer =
        generationMode === "visual_html"
          ? buildVisualHtml(source)
          : (composerArtifact?.artifactBuffer ?? await buildPptxBuffer(source));
      const artifactWarnings =
        generationMode === "editable_native"
          ? inspectEditableNativePptx(artifactBuffer)
          : [];
      if (artifactWarnings.length > 0) {
        warnings.push(...artifactWarnings);
      }
      const artifactId = randomUUID();
      const fileName = `${sanitizeFileName(title)}.${generationMode === "visual_html" ? "html" : "pptx"}`;
      const mimeType =
        generationMode === "visual_html"
          ? "text/html; charset=utf-8"
          : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      const storageKey = buildArtifactStorageKey({
        workspaceId: input.workspaceId,
        artifactId,
        fileName,
      });
      const artifactUrl = buildPptxArtifactUrl({
        workspaceId: input.workspaceId,
        artifactId,
      });
      const pptxUrl =
        generationMode === "editable_native" ? artifactUrl : undefined;
      const htmlUrl =
        generationMode === "visual_html" ? artifactUrl : undefined;
      const enrichedSourceJson = composerArtifact
        ? {
            ...composerArtifact.composerSource,
            renderMetadata: composerArtifact.metadata.renderMetadata,
            qaReport: composerArtifact.metadata.qaReport,
            extensions: {
              ...(composerArtifact.composerSource.extensions ?? {}),
              renderQaReport: composerArtifact.metadata.renderQaReport,
            },
          }
        : visualMetadata
          ? {
              ...source,
              visualSystemVersion: visualMetadata.visualSystemVersion,
              compiledVisualSystem: visualMetadata.compiledVisualSystem,
              resolvedLayouts: visualMetadata.resolvedLayouts,
              compiledVisualScenes: visualMetadata.compiledVisualScenes,
              coverTreatment: visualMetadata.coverTreatment,
              sceneWarnings: visualMetadata.sceneWarnings,
              qaWarnings: visualMetadata.qaWarnings,
            }
          : source;
      const redactedSourceJson = redactSecretLikeMetadata(enrichedSourceJson);
      const sourceJson = JSON.stringify(redactedSourceJson, null, 2);
      const sourceJsonBuffer = Buffer.from(sourceJson, "utf8");
      const sourceJsonFileName = "deck.source.json";
      const sourceJsonStorageKey = effectiveArgs.output?.includeSourceJson
        ? buildArtifactStorageKey({
            workspaceId: input.workspaceId,
            artifactId,
            fileName: sourceJsonFileName,
          })
        : undefined;
      const sourceJsonUrl = sourceJsonStorageKey
        ? buildSourceJsonArtifactUrl({
            workspaceId: input.workspaceId,
            artifactId,
          })
        : undefined;
      const composerObservabilityMetadata = composerArtifact
        ? buildComposerObservabilityMetadata({
            artifactId,
            artifactRefs: {
              pptx: artifactId,
              ...(sourceJsonUrl ? { sourceJson: sourceJsonUrl } : {}),
            },
            composerSource: composerArtifact.composerSource,
            generationId: toolCallId,
            metadata: composerArtifact.metadata,
            renderDurationMs: composerArtifact.renderDurationMs,
            warnings,
          })
        : undefined;

      emitProgress("saving", {
        fileName,
        generationMode,
        internalGenerationMode: generationRoute.internalGenerationMode,
        legacyGenerationMode: generationRoute.legacyGenerationMode,
        sizeBytes: artifactBuffer.byteLength,
      });
      await uploadArtifactObject({
        key: storageKey,
        body: artifactBuffer,
        contentType: mimeType,
      });
      if (sourceJsonStorageKey) {
        await uploadArtifactObject({
          key: sourceJsonStorageKey,
          body: sourceJsonBuffer,
          contentType: "application/json",
        });
      }

      const bucket = getContentStorageBucketName();
      const payload = {
        title,
        prompt: effectiveArgs.brief ?? title,
        mode: effectiveArgs.mode,
        generationMode,
        internalGenerationMode: generationRoute.internalGenerationMode,
        legacyGenerationMode: generationRoute.legacyGenerationMode,
        editable: generationMode === "editable_native",
        previewRenderer:
          generationMode === "visual_html" ? "html_iframe" : "pptxviewjs",
        mimeType,
        fileName,
        aspectRatio: source.design.aspectRatio,
        sizeBytes: artifactBuffer.byteLength,
        storageKey,
        slideCount: source.slides.length,
        ...(generationMode === "visual_html"
          ? {
              html: {
                fileName,
                assetUrl: buildPptxArtifactUrl({
                  workspaceId: input.workspaceId,
                  artifactId,
                }),
              },
              pptxExport: {
                strategy: "frontend_dom_to_pptx",
              },
            }
          : {}),
        ...(generationMode === "editable_native"
          ? {
              pptx: {
                fileName,
                assetUrl: buildPptxArtifactUrl({
                  workspaceId: input.workspaceId,
                  artifactId,
                }),
              },
            }
          : {}),
        sourceJson: undefined,
        sourceJsonBytes: sourceJsonBuffer.byteLength,
        sourceJsonContentType: sourceJsonStorageKey
          ? "application/json"
          : undefined,
        sourceJsonFileName: sourceJsonStorageKey
          ? sourceJsonFileName
          : undefined,
        sourceJsonStorageBucket: sourceJsonStorageKey ? bucket : undefined,
        sourceJsonStorageKey,
        qaSummary:
          warnings.length === 0
            ? "Passed v1 structural QA."
            : `Completed with ${warnings.length} v1 warning(s).`,
        warnings,
        ...(composerArtifact
          ? {
              composer: {
                sourceSchemaVersion: composerArtifact.composerSource.schemaVersion,
                sourceHash: composerArtifact.metadata.renderMetadata?.sourceHash,
                observability: composerObservabilityMetadata,
                renderMetadata: composerArtifact.metadata.renderMetadata,
                qaReport: composerArtifact.metadata.qaReport,
                renderQaReport: composerArtifact.metadata.renderQaReport,
                qaSummary: composerArtifact.metadata.qaSummary,
                renderQaSummary: composerArtifact.metadata.renderQaSummary,
              },
              renderMetadata: composerArtifact.metadata.renderMetadata,
              qaReport: composerArtifact.metadata.qaReport,
              renderQaReport: composerArtifact.metadata.renderQaReport,
              composerObservabilityMetadata,
            }
          : {}),
        ...(visualMetadata
          ? {
              visualSystemVersion: visualMetadata.visualSystemVersion,
              compiledVisualSystem: visualMetadata.compiledVisualSystem,
              resolvedLayouts: visualMetadata.resolvedLayouts,
              compiledVisualScenes: visualMetadata.compiledVisualScenes,
              coverTreatment: visualMetadata.coverTreatment,
              sceneWarnings: visualMetadata.sceneWarnings,
              qaWarnings: visualMetadata.qaWarnings,
            }
          : {}),
      };
      const { versionId } = await createSlidesArtifactRecord({
        artifactId,
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        userId: input.userId,
        title,
        prompt: effectiveArgs.brief ?? title,
        storageBucket: bucket,
        storageKey,
        payload,
      });

      emitProgress("ready", {
        artifactId,
        versionId,
        artifactUrl,
        generationMode,
        internalGenerationMode: generationRoute.internalGenerationMode,
        legacyGenerationMode: generationRoute.legacyGenerationMode,
        pptxUrl,
        htmlUrl,
        sourceJsonUrl,
        warnings,
        ...(composerArtifact
          ? {
              renderMetadata: composerArtifact.metadata.renderMetadata,
              qaReportSummary: composerArtifact.metadata.qaSummary,
              composerObservabilityMetadata,
            }
          : {}),
      });

      return formatToolResult({
        artifactId,
        artifactUrl,
        editable: generationMode === "editable_native",
        fileName,
        generationMode,
        internalGenerationMode: generationRoute.internalGenerationMode,
        legacyGenerationMode: generationRoute.legacyGenerationMode,
        htmlUrl,
        pptxUrl,
        previewRenderer:
          generationMode === "visual_html" ? "html_iframe" : "pptxviewjs",
        versionId,
        title,
        qaSummary: payload.qaSummary,
        slideCount: source.slides.length,
        sourceJsonUrl,
        warnings,
        ...(composerArtifact
          ? {
              renderMetadata: composerArtifact.metadata.renderMetadata,
              qaReportSummary: composerArtifact.metadata.qaSummary,
              composerObservabilityMetadata,
            }
          : {}),
      });
    },
    {
      name: AGENT_TOOL_NAMES.generatePptx,
      description:
        "Generate one persisted SourceWeft native editable PPTX slides artifact from an explicit DeckSpec-style content plan. Before calling, decide the narrative arc, slide mix, visible content slots, and design system. The renderer only lays out provided content; it does not invent titles, captions, subtitles, placeholders, tables, charts, or style labels. SourceWeft creates native editable PPTX by default through the composer/high-quality PPTX route. Legacy generationMode values are accepted only for backward compatibility and normalized internally.",
      schema: generatePptxSchema,
    },
  );
}

export const visualDeckInternals = {
  buildPptxArtifactUrl,
  buildSourceJsonArtifactUrl,
  buildVisualHtml,
  buildQaWarnings,
  buildVisualDeckBlockingQaWarnings,
  classifySlideContentShape,
  compileVisualSystem,
  extractVisualDeckMetadata,
  normalizeDeckSpec,
  normalizeDeckSource,
  repairDeckSpec,
  resolveSafeLayout,
  resolveVisualSlides,
  sanitizeFileName,
  validateVisualDeckSource,
  verifyDeckLayout,
};

export function looksLikePresentationSpecText(value: string) {
  const record = parseJsonObjectText(value);
  if (!record) {
    return false;
  }
  const content = toObjectRecord(record.content);
  const cover = toObjectRecord(content?.cover);
  return (
    Array.isArray(record.slides) &&
    (typeof record.title === "string" ||
      typeof cover?.title === "string" ||
      record.schemaVersion === 1) &&
    (record.mode === "create" ||
      record.generationMode === "visual_html" ||
      record.generationMode === "editable_native" ||
      toObjectRecord(record.design) !== null ||
      content !== null)
  );
}

function parseJsonObjectText(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  try {
    return toObjectRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export function buildPptxRuntimePromptLines(input: {
  pptxSelection: GeneratePptxToolSelection | undefined;
}): string[] {
  const { pptxSelection } = input;
  const generationRoute = normalizePptxGenerationRoute({
    generationMode: pptxSelection?.generationMode,
  });
  const sharedPptxPlanningGuidance =
    "Before calling generate_pptx, create a complete DeckSpec-style plan with controlled safety constraints: audience goal, narrative arc, claim spine, slide mix, each slide intent, content density, visible content slots, proof objects, and resolved design system. Do not use a fixed slide sequence unless the user asks for one. Treat custom style as design intent only; map it to safe registered layouts instead of inventing arbitrary geometry.";
  const nativePptxGuidance =
    "Native PPTX output should favor clean PowerPoint-native editable text, shapes, tables, and charts. For each slide, create only objects consumed by visible content; do not leave blank cards, unused placeholders, empty media frames, overlay-only faux layouts, or repeated empty layout geometry.";
  return [
    `${AGENT_TOOL_NAMES.generatePptx} is available for presentation artifacts. Use it when the user asks to create a PPT, PPTX, slide deck, or presentation artifact.`,
    `Deck generation route: ${generationRoute.internalGenerationMode}. SourceWeft creates native editable PPTX by default through the composer/high-quality PPTX route. Legacy generationMode inputs are accepted only for backward compatibility and normalized internally.`,
    `Legacy generation mode requested: ${generationRoute.legacyGenerationMode}.`,
    pptxSelection?.design
      ? `PPTX design defaults: style_preset=${pptxSelection.design.stylePreset ?? "custom"}, aspect_ratio=${pptxSelection.design.aspectRatio ?? "16:9"}, language=${pptxSelection.design.language ?? "auto"}.`
      : "PPTX design defaults: style_preset=custom, aspect_ratio=16:9, language=auto.",
    sharedPptxPlanningGuidance,
    nativePptxGuidance,
    "Choose a style preset that fits the audience: executive, technical, editorial, data-heavy, or custom. For custom, provide design.customBrief and design.visualSystem so the model controls the visual direction instead of relying on a coded theme label.",
    "For custom decks, separate customStyle from resolvedDesignSystem mentally: customBrief can describe mood, brand, tone, density, palette, and typography, but visible slide structure must still use safe content shapes such as section, paragraph, steps, cards, quote, comparison, chart, table, image, or closing.",
    "For education, teaching, study, classroom, course, training, or Feynman-style decks, default the resolved design family to education/instructional layouts. Do not set styleFamily=editorial or magazine for education content unless the user explicitly requests a magazine/editorial treatment.",
    "Treat generationMode, style_preset, customBrief, templateArtifactId, aspect_ratio, language, and file format labels as internal tool configuration only; do not use them as visible slide titles, subtitles, eyebrow text, headers, footers, captions, placeholders, or body copy unless the user explicitly wrote that wording as content.",
    "Provide visible text explicitly through content.cover fields and slide title/kicker/caption/footer/body fields. Keep each text slot concise; never concatenate serialized JSON, sibling fields, arrays, internal planning notes, or tool configuration into a visible text field such as content.cover.subtitle.",
    "For Chinese decks, all visible title, body, caption, footer, and cover text must be Chinese unless the user supplied a specific English term. Do not leak planning fragments such as opener, layout, audience, or four-step method into visible copy.",
    "Use 2-4 short bullets for step pages, 3-6 short bullets for card grids, and a paragraph slide for one long explanation. Do not map card grids to longform layouts, and do not create a content slide with an empty body or a single short bullet unless it is intentionally a section or quote slide.",
    "The presentation tool blocks saving on layout QA failures such as repeated macro layouts, empty render blocks, single-card grid holes, cards mapped into longform, unrequested cover decoration, and language pollution; fix those in the tool arguments before retrying.",
    "The renderer does not invent missing subtitles, captions, chart data, table rows, quote text, or placeholders.",
    "When templateArtifactId is present, use it only as a visual_reference or layout_reference in v1. Generate fresh cover title/subtitle and slide copy from the user's content; do not preserve template sample text.",
    `Never claim a deck artifact was created unless ${AGENT_TOOL_NAMES.generatePptx} completed successfully.`,
    `After ${AGENT_TOOL_NAMES.generatePptx} succeeds, decide whether a short natural-language wrap-up is useful. The application displays the deck card automatically; do not include raw artifact IDs, raw artifact URLs, source JSON, or tool schemas.`,
  ];
}

export const pptxRuntimePromptProvider: import("../prompts/tool-prompt-provider").ArtifactToolRuntimePromptProvider = {
  buildLines(context: RuntimePromptContext) {
    if (!context.availableArtifactTools.includes(AGENT_TOOL_NAMES.generatePptx)) {
      return [];
    }
    return buildPptxRuntimePromptLines({ pptxSelection: context.generatePptxTool });
  },
};

export const testExports = {
  buildPptxBuffer,
  buildPptxRuntimePromptLines,
  buildVisualHtml,
  buildPptxArtifactUrl,
  buildSourceJsonArtifactUrl,
  buildComposerObservabilityMetadata,
  bodyToBullets,
  buildQaWarnings,
  buildVisualDeckBlockingQaWarnings,
  classifySlideContentShape,
  compileVisualSystem,
  createHtmlTableShim,
  extractPptxShapeFragments,
  extractPptxSlideXml,
  extractVisualDeckMetadata,
  fallbackSlides,
  formatToolResult,
  deckSourceToComposerSource,
  redactSecretLikeMetadata,
  summarizeComposerMetadata,
  buildComposerPptxArtifact,
  generatePptxSchema,
  hasSufficientAuthoredDeckContent,
  inspectEditableNativePptx,
  normalizeDeckSpec,
  normalizePptxGenerationRoute,
  parseGeneratePptxArgs,
  repairDeckSpec,
  resolveSafeLayout,
  resolveVisualSlides,
  sanitizeFileName,
  validateVisualDeckSource,
  verifyDeckLayout,
  normalizeRowsForHtml,
  normalizeChartData,
  normalizeDeckSource,
  normalizeRows,
};
