import { z } from "zod";
import {
  videoPresentationCompositionSchema,
  videoPresentationMoodSchema,
  videoPresentationMotionSchema,
  videoPresentationSceneTypeSchema,
  videoPresentationThemeSchema,
  videoPresentationSpecSchema,
  type VideoPresentationComposition,
  type VideoPresentationMood,
  type VideoPresentationScene,
  type VideoPresentationSceneType,
  type VideoPresentationSlide,
  type VideoPresentationSpec,
  type VideoPresentationTheme,
} from "@sourceweft/contracts/video-presentation";
import { getModelGatewayClient } from "../../../shared/model-gateway/client";
import { requireDefaultModelGatewayProfile } from "../../../shared/model-gateway";
import { resolveAssistantContent } from "../threads/thread/title";
import type { ContentBillingPort } from "../billing-port";
import { meterBillableModelUsage } from "../model-billing";
import { logger } from "../../../shared/logger";
import {
  compactVideoPresentationText,
  stripVideoPresentationMarkdown,
} from "./spec";

const partialThemeSchema = z.object({
  background: z.string().trim().min(1).max(80).optional(),
  foreground: z.string().trim().min(1).max(80).optional(),
  accent: z.string().trim().min(1).max(80).optional(),
  secondary: z.string().trim().min(1).max(80).optional(),
  muted: z.string().trim().min(1).max(80).optional(),
  fontFamily: z.string().trim().min(1).max(120).optional(),
});

const longPlannerStringSchema = z.string().trim().min(1).max(10_000);

const plannerSlideNumberSchema = z.preprocess((value) => {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return value;
}, z.number().int().min(1).max(80).optional());

const plannerStringArraySchema = z.preprocess((value) => {
  if (typeof value === "string") {
    return [value];
  }
  return value;
}, z.array(longPlannerStringSchema).max(16).default([]));

const plannerSlideSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = { ...(value as Record<string, unknown>) };
  if (typeof record.speakerTranscript === "string") {
    record.speakerTranscript = [record.speakerTranscript];
  }
  if (!record.contentMarkdown && typeof record.content === "string") {
    record.contentMarkdown = record.content;
  }
  return record;
}, z.object({
  slideNumber: plannerSlideNumberSchema,
  title: longPlannerStringSchema.optional(),
  heading: longPlannerStringSchema.optional(),
  subtitle: longPlannerStringSchema.optional(),
  contentMarkdown: longPlannerStringSchema.optional(),
  content: longPlannerStringSchema.optional(),
  speakerTranscript: plannerStringArraySchema,
  backgroundDirection: longPlannerStringSchema.optional(),
}).passthrough());

const plannerSceneSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = { ...(value as Record<string, unknown>) };
  if (!record.sceneType && typeof record.type === "string") {
    record.sceneType = record.type;
  }
  if (!record.sceneType && typeof record.kind === "string") {
    record.sceneType = record.kind;
  }
  if (!record.sceneType) {
    record.sceneType = "content";
  }
  const sceneType = String(record.sceneType);
  if (!videoPresentationSceneTypeSchema.safeParse(sceneType).success) {
    record.sceneType = "content";
  }
  if (!record.title && typeof record.heading === "string") {
    record.title = record.heading;
  }
  if (!record.visualPrompt && typeof record.visuals === "string") {
    record.visualPrompt = record.visuals;
  }
  return record;
}, z.object({
  slideNumber: plannerSlideNumberSchema,
  sceneType: longPlannerStringSchema.optional(),
  type: longPlannerStringSchema.optional(),
  kind: longPlannerStringSchema.optional(),
  composition: longPlannerStringSchema.optional(),
  mood: longPlannerStringSchema.optional(),
  title: longPlannerStringSchema.optional(),
  heading: longPlannerStringSchema.optional(),
  subtitle: longPlannerStringSchema.optional(),
  kicker: longPlannerStringSchema.optional(),
  bullets: plannerStringArraySchema,
  quote: longPlannerStringSchema.optional(),
  metrics: z.array(z.record(z.string(), z.unknown())).max(12).default([]),
  timeline: z.array(z.record(z.string(), z.unknown())).max(12).default([]),
  visualPrompt: longPlannerStringSchema.optional(),
  visuals: longPlannerStringSchema.optional(),
  motion: z.unknown().optional(),
}).passthrough());

const plannerResponseSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  title: z.string().trim().min(1).max(1000).optional(),
  fps: z.number().int().min(12).max(60).optional(),
  width: z.number().int().min(640).max(3840).optional(),
  height: z.number().int().min(360).max(2160).optional(),
  theme: z
    .union([partialThemeSchema, z.string().trim().min(1).max(500)])
    .optional(),
  slides: z.array(plannerSlideSchema).min(1).max(40),
  scenes: z.array(plannerSceneSchema).max(40).default([]),
  narrationEnabled: z.boolean().optional(),
});

type PlannerResponse = z.infer<typeof plannerResponseSchema>;

const DEFAULT_DARK_THEME = {
  background: "#0b1017",
  foreground: "#f8fafc",
  accent: "#38bdf8",
  secondary: "#f59e0b",
  muted: "#94a3b8",
  fontFamily: "Inter, sans-serif",
} satisfies VideoPresentationTheme;

const WARM_ACADEMIC_THEME = {
  background: "#f6efe2",
  foreground: "#17213a",
  accent: "#b8872b",
  secondary: "#245074",
  muted: "#6f6558",
  fontFamily: '"Noto Serif SC", "Source Han Serif SC", Georgia, serif',
} satisfies VideoPresentationTheme;

const CHALKBOARD_THEME = {
  background: "#18251d",
  foreground: "#f5efd7",
  accent: "#e0bd63",
  secondary: "#8fc6a3",
  muted: "#b8c6b4",
  fontFamily: '"LXGW WenKai", KaiTi, Georgia, serif',
} satisfies VideoPresentationTheme;

const WHITEBOARD_THEME = {
  background: "#f9faf8",
  foreground: "#111827",
  accent: "#2563eb",
  secondary: "#d97706",
  muted: "#64748b",
  fontFamily: '"Noto Sans SC", "Microsoft YaHei", Arial, sans-serif',
} satisfies VideoPresentationTheme;

const MODERN_EDITORIAL_THEME = {
  background: "#f7f9fb",
  foreground: "#101828",
  accent: "#0f766e",
  secondary: "#d97706",
  muted: "#667085",
  fontFamily: '"Noto Sans SC", "Aptos", Arial, sans-serif',
} satisfies VideoPresentationTheme;

const CINEMATIC_DARK_THEME = {
  background: "#12151b",
  foreground: "#f7f3ea",
  accent: "#c9a227",
  secondary: "#2dd4bf",
  muted: "#b8b3a8",
  fontFamily: '"Noto Sans SC", "Aptos", Arial, sans-serif',
} satisfies VideoPresentationTheme;

const PLANNER_TIMEOUT_MS = 90_000;

type ThemeInput = NonNullable<PlannerResponse["theme"]>;

function normalizeSlideNumber(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return fallback;
}

function splitTranscriptLines(value: string, maxParts = 6) {
  const cleaned = stripVideoPresentationMarkdown(value);
  if (!cleaned) {
    return [];
  }
  const parts = cleaned
    .split(/(?<=[.!?。！？;；])\s+|\n+/u)
    .map((part) => stripVideoPresentationMarkdown(part))
    .filter(Boolean);
  const selected = parts.length > 0 ? parts : [cleaned];
  const lines: string[] = [];
  for (const part of selected) {
    if (part.length <= 360) {
      lines.push(part);
      continue;
    }
    for (let index = 0; index < part.length; index += 340) {
      lines.push(part.slice(index, index + 340).trim());
      if (lines.length >= maxParts) {
        break;
      }
    }
    if (lines.length >= maxParts) {
      break;
    }
  }
  return lines.slice(0, maxParts);
}

function normalizePlannerTextArray(
  values: string[],
  maxItems: number,
  maxLength: number,
) {
  return values
    .flatMap((value) => splitTranscriptLines(value, maxItems))
    .map((value) => compactVideoPresentationText(value, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeSceneType(value: unknown, fallback = "content") {
  const candidate = typeof value === "string" ? value : fallback;
  return videoPresentationSceneTypeSchema.safeParse(candidate).success
    ? (candidate as VideoPresentationSceneType)
    : (fallback as VideoPresentationSceneType);
}

function normalizeComposition(value: unknown) {
  const candidate = typeof value === "string" ? value : undefined;
  return videoPresentationCompositionSchema.safeParse(candidate).success
    ? (candidate as VideoPresentationComposition)
    : "cinematic";
}

function normalizeMood(value: unknown) {
  const candidate = typeof value === "string" ? value : undefined;
  return videoPresentationMoodSchema.safeParse(candidate).success
    ? (candidate as VideoPresentationMood)
    : "editorial";
}

function normalizeMotion(value: unknown) {
  const parsed = videoPresentationMotionSchema.safeParse(value);
  return parsed.success ? parsed.data : videoPresentationMotionSchema.parse({});
}

function normalizeMetrics(values: Array<Record<string, unknown>>) {
  return values
    .flatMap((value) => {
      const label = sanitizeVisibleString(
        typeof value.label === "string"
          ? value.label
          : typeof value.name === "string"
            ? value.name
            : undefined,
        {},
      );
      const metricValue = sanitizeVisibleString(
        typeof value.value === "string"
          ? value.value
          : typeof value.amount === "string"
            ? value.amount
            : undefined,
        {},
      );
      if (!label || !metricValue) {
        return [];
      }
      const delta = sanitizeVisibleString(
        typeof value.delta === "string" ? value.delta : undefined,
        {},
      );
      return [
        {
          label,
          value: metricValue,
          ...(delta ? { delta } : {}),
        },
      ];
    })
    .slice(0, 4);
}

function normalizeTimeline(values: Array<Record<string, unknown>>) {
  return values
    .flatMap((value) => {
      const label = sanitizeVisibleString(
        typeof value.label === "string"
          ? value.label
          : typeof value.title === "string"
            ? value.title
            : undefined,
        {},
      );
      if (!label) {
        return [];
      }
      const detail = sanitizeVisibleString(
        typeof value.detail === "string"
          ? value.detail
          : typeof value.content === "string"
            ? value.content
            : undefined,
        {},
      );
      return [
        {
          label,
          ...(detail ? { detail } : {}),
        },
      ];
    })
    .slice(0, 6);
}

function extractJsonObject(text: string) {
  const withoutFence = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Video presentation planner did not return JSON.");
  }
  return JSON.parse(withoutFence.slice(start, end + 1));
}

function splitContentIntoBullets(value: string, max = 5) {
  return value
    .split(/\n+|(?:^|\s)[-*]\s+/g)
    .map((line) => stripVideoPresentationMarkdown(line))
    .filter(Boolean)
    .slice(0, max)
    .map((line) => compactVideoPresentationText(line, 180));
}

function splitContentIntoSentences(value: string) {
  const cleaned = stripVideoPresentationMarkdown(value);
  const sentences = cleaned
    .split(/(?<=[.!?。！？])\s+|\n{2,}/u)
    .map((part) => stripVideoPresentationMarkdown(part))
    .filter(Boolean);
  if (sentences.length > 0) {
    return sentences;
  }
  return cleaned
    .split(/\s*(?:第[一二三四五六七八九十]+步[:：]|#{1,6}\s+)\s*/u)
    .map((part) => stripVideoPresentationMarkdown(part))
    .filter(Boolean);
}

function deriveFallbackTitle(text: string, fallback: string, index: number) {
  const cleaned = stripVideoPresentationMarkdown(text);
  const compactTitle = (value: string) =>
    value.replace(/\s+/g, " ").trim().slice(0, 38);
  const headingMatch = cleaned.match(
    /(?:什么是|为什么|如何|总结|第[一二三四五六七八九十]+步[:：]?)[^。！？.!?]{0,28}/u,
  );
  const heading = headingMatch?.[0]?.replace(/[:：]\s*$/, "").trim();
  if (heading && heading.length >= 3) {
    return compactTitle(heading);
  }

  const sentence = cleaned.split(/[。！？.!?；;，,：:]/u)[0]?.trim();
  if (sentence && sentence.length >= 4) {
    return compactTitle(sentence);
  }

  const fallbackTitles = [
    fallback,
    "核心理念",
    "操作步骤",
    "发现缺口",
    "回顾简化",
    "实践应用",
    "关键总结",
  ];
  return fallbackTitles[index] ?? "关键总结";
}

function pickFallbackSceneType(index: number, total: number) {
  if (index === 0) {
    return "title" as const;
  }
  if (index === total - 1) {
    return "closing" as const;
  }
  if (index === 1) {
    return "quote" as const;
  }
  if (index === 2) {
    return "process" as const;
  }
  return index % 2 === 0 ? ("comparison" as const) : ("content" as const);
}

function pickFallbackComposition(index: number) {
  const compositions = [
    "cinematic",
    "split",
    "stacked",
    "radial",
    "data-wall",
  ] as const;
  return compositions[index % compositions.length] ?? "cinematic";
}

function pickFallbackMood(index: number) {
  const moods = [
    "calm",
    "editorial",
    "technical",
    "executive",
    "dramatic",
  ] as const;
  return moods[index % moods.length] ?? "calm";
}

function normalizeComparableText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s"'“”‘’`.,，。:：;；!?！？\-–—()[\]{}<>《》]+/g, "");
}

function containsLongPromptFragment(value: string, userPrompt?: string) {
  if (!userPrompt) {
    return false;
  }
  const normalizedValue = normalizeComparableText(value);
  const normalizedPrompt = normalizeComparableText(userPrompt);
  if (!normalizedValue || !normalizedPrompt) {
    return false;
  }
  if (
    normalizedPrompt.length >= 24 &&
    normalizedValue.includes(normalizedPrompt.slice(0, 24))
  ) {
    return true;
  }
  for (let index = 0; index <= normalizedPrompt.length - 28; index += 10) {
    if (normalizedValue.includes(normalizedPrompt.slice(index, index + 28))) {
      return true;
    }
  }
  return false;
}

function looksLikeCreativeDirection(value: string, userPrompt?: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return false;
  }
  if (containsLongPromptFragment(compact, userPrompt)) {
    return true;
  }
  const normalized = normalizeComparableText(compact);
  const creativeTerms = [
    "制作一个",
    "制作一段",
    "生成一个",
    "面向",
    "中文观众",
    "风格",
    "色彩",
    "视觉",
    "旁白",
    "节奏",
    "受众",
    "适合",
    "creative direction",
    "audience",
    "visual style",
    "pacing",
    "tone",
  ];
  const hitCount = creativeTerms.filter((term) =>
    normalized.includes(normalizeComparableText(term)),
  ).length;
  return compact.length > 28 && hitCount >= 2;
}

function sanitizeVisibleString(
  value: string | undefined,
  input: { fallback?: string; userPrompt?: string },
) {
  const compact = value
    ? stripVideoPresentationMarkdown(value).replace(/\s+/g, " ").trim()
    : undefined;
  if (!compact || looksLikeCreativeDirection(compact, input.userPrompt)) {
    return input.fallback;
  }
  return compact;
}

function limitVisibleString(value: string, maxLength: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength
    ? compact
    : compact.slice(0, maxLength).trimEnd();
}

function limitOptionalVisibleString(
  value: string | undefined,
  maxLength: number,
) {
  return value ? limitVisibleString(value, maxLength) : undefined;
}

function sanitizeVisibleStringArray(
  values: string[],
  input: { fallback?: string[]; userPrompt?: string },
) {
  const sanitized = values
    .map((value) =>
      sanitizeVisibleString(value, {
        fallback: undefined,
        userPrompt: input.userPrompt,
      }),
    )
    .filter((value): value is string => Boolean(value));
  if (sanitized.length > 0) {
    return sanitized;
  }
  return input.fallback ?? [];
}

function isDefaultishTheme(theme: VideoPresentationTheme) {
  const defaults = videoPresentationThemeSchema.parse({});
  return (
    theme.background === defaults.background &&
    theme.foreground === defaults.foreground &&
    (theme.accent === defaults.accent || theme.accent === "#38bdf8")
  );
}

function parseThemeCandidate(theme: ThemeInput | undefined) {
  if (!theme || typeof theme === "string") {
    return null;
  }
  const parsed = videoPresentationThemeSchema.partial().safeParse(theme);
  return parsed.success ? parsed.data : null;
}

function inferThemeFromPrompt(
  userPrompt?: string,
): VideoPresentationTheme | null {
  const text = userPrompt?.toLowerCase() ?? "";
  if (!text.trim()) {
    return null;
  }
  if (
    /米白|象牙|金色|金色点缀|学术|温暖|serif|serif typography|academic/.test(
      text,
    ) ||
    ((text.includes("深蓝") || text.includes("navy")) &&
      (text.includes("金") || text.includes("gold")))
  ) {
    return WARM_ACADEMIC_THEME;
  }
  if (/黑板|粉笔|手写|板书|chalk|chalkboard/.test(text)) {
    return CHALKBOARD_THEME;
  }
  if (/白板|whiteboard|极简|清爽|干净/.test(text)) {
    return WHITEBOARD_THEME;
  }
  if (/电影|cinematic|dramatic|暗色|深色|高级感/.test(text)) {
    return CINEMATIC_DARK_THEME;
  }
  if (/现代|商务|编辑|杂志|editorial|executive|modern/.test(text)) {
    return MODERN_EDITORIAL_THEME;
  }
  return null;
}

function resolveTheme(input: {
  plannedTheme?: ThemeInput;
  userPrompt?: string;
}): VideoPresentationTheme {
  const inferred = inferThemeFromPrompt(input.userPrompt);
  const parsed = parseThemeCandidate(input.plannedTheme);
  const planned = parsed
    ? videoPresentationThemeSchema.parse({
        ...(inferred ?? DEFAULT_DARK_THEME),
        ...parsed,
      })
    : null;
  const promptHasStyleHint = Boolean(input.userPrompt?.trim());
  if (
    planned &&
    (!isDefaultishTheme(planned) || !inferred) &&
    !(inferred && promptHasStyleHint)
  ) {
    return planned;
  }
  return inferred ?? planned ?? DEFAULT_DARK_THEME;
}

function sanitizePlannedContent(
  parsed: PlannerResponse,
  input: { title: string; userPrompt?: string },
) {
  const slides = parsed.slides.map((slide, index): VideoPresentationSlide => {
    const contentMarkdown = limitOptionalVisibleString(
      sanitizeVisibleString(slide.contentMarkdown ?? slide.content, {
        userPrompt: input.userPrompt,
      }),
      1600,
    );
    const transcriptFallback = contentMarkdown
      ? [contentMarkdown]
      : [`本段介绍${input.title}。`];
    const rawTitle = slide.title ?? slide.heading;
    const titleFallback = rawTitle
      ? input.title
      : deriveFallbackTitle(
          contentMarkdown ?? transcriptFallback[0] ?? input.title,
          input.title,
          index,
        );
    const title = limitVisibleString(
      sanitizeVisibleString(rawTitle, {
        fallback: titleFallback,
        userPrompt: input.userPrompt,
      }) ?? titleFallback,
      180,
    );
    const speakerTranscript =
      normalizePlannerTextArray(
        sanitizeVisibleStringArray(slide.speakerTranscript, {
          fallback: contentMarkdown ? [contentMarkdown] : [`本段介绍${title}。`],
          userPrompt: input.userPrompt,
        }),
        6,
        360,
      ) || [];
    const safeSpeakerTranscript =
      speakerTranscript.length > 0 ? speakerTranscript : [`本段介绍${title}。`];
    return {
      slideNumber: normalizeSlideNumber(slide.slideNumber, index + 1),
      title,
      subtitle: limitOptionalVisibleString(
        sanitizeVisibleString(slide.subtitle, {
          userPrompt: input.userPrompt,
        }),
        260,
      ),
      contentMarkdown,
      backgroundDirection: limitOptionalVisibleString(
        sanitizeVisibleString(slide.backgroundDirection, {
          userPrompt: input.userPrompt,
        }),
        500,
      ),
      speakerTranscript: safeSpeakerTranscript,
    };
  });

  const titleBySlide = new Map(
    slides.map((slide) => [slide.slideNumber, slide.title]),
  );
  const rawScenes =
    parsed.scenes.length > 0
      ? parsed.scenes
      : slides.map((slide, index) => ({
          slideNumber: slide.slideNumber,
          sceneType: pickFallbackSceneType(index, slides.length),
          composition: pickFallbackComposition(index),
          mood: pickFallbackMood(index),
          title: slide.title,
          bullets: splitContentIntoBullets(
            slide.contentMarkdown ?? slide.speakerTranscript.join(" "),
          ),
          metrics: [],
          timeline: [],
        }));
  const scenes = rawScenes.map((scene, index): VideoPresentationScene => {
    const sceneRecord = scene as Record<string, unknown> & {
      bullets?: string[];
      metrics?: Array<Record<string, unknown>>;
      timeline?: Array<Record<string, unknown>>;
    };
    const slideNumber = normalizeSlideNumber(scene.slideNumber, index + 1);
    const matchingSlide = slides.find(
      (slide) => slide.slideNumber === slideNumber,
    );
    const fallbackTitle =
      titleBySlide.get(slideNumber) ?? matchingSlide?.title ?? input.title;
    const bullets = sanitizeVisibleStringArray(sceneRecord.bullets ?? [], {
      userPrompt: input.userPrompt,
    })
      .map((bullet) => limitVisibleString(bullet, 220))
      .slice(0, 6);
    const fallbackBullets =
      bullets.length > 0
        ? bullets
        : splitContentIntoBullets(
            matchingSlide?.contentMarkdown ??
              matchingSlide?.speakerTranscript.join(" ") ??
              fallbackTitle,
          );
    return {
      slideNumber,
      sceneType: normalizeSceneType(
        sceneRecord.sceneType ?? sceneRecord.type ?? sceneRecord.kind,
        pickFallbackSceneType(index, rawScenes.length),
      ),
      composition: normalizeComposition(sceneRecord.composition),
      mood: normalizeMood(sceneRecord.mood),
      title: limitVisibleString(
        sanitizeVisibleString(
          typeof sceneRecord.title === "string"
            ? sceneRecord.title
            : typeof sceneRecord.heading === "string"
              ? sceneRecord.heading
              : undefined,
          {
          fallback: fallbackTitle,
          userPrompt: input.userPrompt,
          },
        ) ?? fallbackTitle,
        180,
      ),
      subtitle: limitOptionalVisibleString(
        sanitizeVisibleString(
          typeof sceneRecord.subtitle === "string"
            ? sceneRecord.subtitle
            : undefined,
          {
          userPrompt: input.userPrompt,
          },
        ),
        260,
      ),
      kicker: limitOptionalVisibleString(
        sanitizeVisibleString(
          typeof sceneRecord.kicker === "string" ? sceneRecord.kicker : undefined,
          {
          userPrompt: input.userPrompt,
          },
        ),
        120,
      ),
      bullets: fallbackBullets,
      quote: limitOptionalVisibleString(
        sanitizeVisibleString(
          typeof sceneRecord.quote === "string" ? sceneRecord.quote : undefined,
          {
          userPrompt: input.userPrompt,
          },
        ),
        360,
      ),
      metrics: normalizeMetrics(sceneRecord.metrics ?? []),
      timeline: normalizeTimeline(sceneRecord.timeline ?? []),
      visualPrompt: limitOptionalVisibleString(
        sanitizeVisibleString(
          typeof sceneRecord.visualPrompt === "string"
            ? sceneRecord.visualPrompt
            : typeof sceneRecord.visuals === "string"
              ? sceneRecord.visuals
              : undefined,
          {
          userPrompt: input.userPrompt,
          },
        ),
        500,
      ),
      motion: normalizeMotion(sceneRecord.motion),
    };
  });

  return { slides, scenes };
}

function buildFallbackSpec(input: {
  narrationEnabled: boolean;
  sourceContent: string;
  title: string;
  userPrompt?: string;
}): VideoPresentationSpec {
  const compact = compactVideoPresentationText(input.sourceContent, 5000);
  const chunks = splitContentIntoSentences(compact);
  const slideTexts = chunks.length > 0 ? chunks : [compact || input.title];
  const selected = slideTexts.slice(
    0,
    Math.max(3, Math.min(6, slideTexts.length)),
  );
  const slides: VideoPresentationSlide[] = [
    {
      slideNumber: 1,
      title: input.title,
      contentMarkdown: compactVideoPresentationText(
        stripVideoPresentationMarkdown(selected[0] ?? compact),
        600,
      ),
      speakerTranscript: [
        compactVideoPresentationText(
          stripVideoPresentationMarkdown(
            selected[0] ?? `This video presentation introduces ${input.title}.`,
          ),
          320,
        ),
      ],
    },
    ...selected.slice(1).map((text, index) => ({
      slideNumber: index + 2,
      title: deriveFallbackTitle(text, input.title, index + 1),
      contentMarkdown: compactVideoPresentationText(
        stripVideoPresentationMarkdown(text),
        600,
      ),
      speakerTranscript: [
        compactVideoPresentationText(stripVideoPresentationMarkdown(text), 360),
      ],
    })),
  ];
  if (slides.length < 3) {
    slides.push({
      slideNumber: slides.length + 1,
      title: "关键总结",
      contentMarkdown: compactVideoPresentationText(
        stripVideoPresentationMarkdown(compact),
        600,
      ),
      speakerTranscript: [
        compactVideoPresentationText(
          `The main takeaway is to connect the source material into a clear story for ${input.title}.`,
          360,
        ),
      ],
    });
  }

  const scenes: VideoPresentationScene[] = slides.map((slide, index) => ({
    slideNumber: slide.slideNumber,
    sceneType: pickFallbackSceneType(index, slides.length),
    composition: pickFallbackComposition(index),
    mood: pickFallbackMood(index),
    title: slide.title,
    subtitle: slide.subtitle,
    bullets: splitContentIntoBullets(
      slide.contentMarkdown ?? slide.speakerTranscript.join(" "),
    ),
    quote:
      index === 1
        ? compactVideoPresentationText(
            slide.speakerTranscript.join(" "),
            220,
          )
        : undefined,
    metrics: [],
    timeline: [],
    motion: {
      camera: index === 0 ? "slow-push" : "pan",
      emphasis: "spotlight",
      entrance: index === 0 ? "scale" : "rise",
      transition: "fade",
    },
  }));

  return videoPresentationSpecSchema.parse({
    schemaVersion: 1,
    title: input.title,
    fps: 30,
    width: 1920,
    height: 1080,
    narrationEnabled: input.narrationEnabled,
    theme: resolveTheme({ userPrompt: input.userPrompt }),
    slides,
    scenes,
    audioTracks: [],
  });
}

export async function planVideoPresentationSpec(input: {
  artifactId: string;
  billing?: ContentBillingPort;
  narrationEnabled: boolean;
  parentSpanId?: string;
  sourceContent: string;
  teamId: string;
  threadId: string;
  title: string;
  traceId?: string;
  userId: string;
  userMessageId: string;
  userPrompt?: string;
  workspaceId: string;
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  const profile = await requireDefaultModelGatewayProfile("chat");
  input.signal?.throwIfAborted();
  const gateway = await getModelGatewayClient(profile.gatewayConfigId);
  input.signal?.throwIfAborted();
  const completion = await gateway.chat.complete(
    {
      model: profile.modelAlias,
      profileAlias: profile.profileAlias,
      temperature: 0.4,
      maxTokens: 5000,
      responseFormat: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You plan video presentations for a trusted Remotion renderer. Return only JSON. Do not include TSX, HTML, CSS, JavaScript, markdown fences, or executable code. Create concise visual scenes and speaker transcripts from the source material.",
        },
        {
          role: "user",
          content: [
            `Title: ${input.title}`,
            `Narration enabled: ${input.narrationEnabled ? "yes" : "no"}`,
            input.userPrompt ? `Creative direction: ${input.userPrompt}` : "",
            "Creative direction controls visual and narration style only. Do not copy it into slide titles, subtitles, bullets, quotes, or speakerTranscript unless the user explicitly asked to include those words as content.",
            "Return this shape: {schemaVersion:1,title,fps,width,height,theme,slides,scenes,narrationEnabled}.",
            "Scene objects must use sceneType, not type. Slide objects must use contentMarkdown, not content.",
            "Use plain human-facing text. Do not put markdown headings, hashes, bullet markers, JSON schema words, or prompt instructions in titles, bullets, quotes, contentMarkdown, or speakerTranscript.",
            "Use 4-8 slides unless the source clearly needs more. Each slide must have speakerTranscript. Match each scene.slideNumber to a slide.",
            "Scene types: title, content, comparison, timeline, metric, quote, process, image-led, closing.",
            "Compositions: cinematic, split, stacked, radial, data-wall. Moods: executive, technical, editorial, energetic, calm, dramatic.",
            "Use a balanced palette; avoid one-note purple/blue gradients unless explicitly requested.",
            "Source content:",
            compactVideoPresentationText(input.sourceContent, 18_000),
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
      metadata: {
        team_id: input.teamId,
        workspace_id: input.workspaceId,
        user_id: input.userId,
        thread_id: input.threadId,
        message_id: input.userMessageId,
        feature: "artifact.video_presentation",
        artifactId: input.artifactId,
      },
    },
    {
      idempotencyKey: `artifact-video-presentation:${input.artifactId}:plan`,
      signal: input.signal,
      timeoutMs: PLANNER_TIMEOUT_MS,
      traceId: input.traceId,
      metadata: {
        parentSpanId: input.parentSpanId,
        artifactId: input.artifactId,
        operation: "video_presentation.plan",
      },
    },
  );
  input.signal?.throwIfAborted();

  if (input.billing) {
    input.signal?.throwIfAborted();
    await meterBillableModelUsage({
      billing: input.billing,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      actorUserId: input.userId,
      feature: "artifact.video_presentation",
      operation: "chat.complete",
      modelKind: "chat",
      gatewayConfigId: profile.gatewayConfigId,
      profileAlias: profile.profileAlias,
      modelAlias: profile.modelAlias,
      referenceId: `artifact:${input.artifactId}:plan`,
      idempotencyKey: `artifact-video-presentation:${input.artifactId}:plan`,
      usage: completion.usage,
      metadata: {
        traceId: input.traceId,
        threadId: input.threadId,
        messageId: input.userMessageId,
        artifactId: input.artifactId,
      },
    });
  }
  input.signal?.throwIfAborted();

  try {
    const text = resolveAssistantContent({ raw: completion.raw });
    const parsed = plannerResponseSchema.parse(extractJsonObject(text));
    const sanitized = sanitizePlannedContent(parsed, {
      title: input.title,
      userPrompt: input.userPrompt,
    });
    return videoPresentationSpecSchema.parse({
      schemaVersion: 1,
      fps: 30,
      width: 1920,
      height: 1080,
      audioTracks: [],
      ...parsed,
      title: parsed.title || input.title,
      theme: resolveTheme({
        plannedTheme: parsed.theme,
        userPrompt: input.userPrompt,
      }),
      slides: sanitized.slides,
      scenes: sanitized.scenes,
      narrationEnabled: input.narrationEnabled,
    });
  } catch (error) {
    logger.warn("Video presentation planner fell back to heuristic spec", {
      artifactId: input.artifactId,
      error:
        error instanceof Error
          ? error.message.split("\n", 1)[0]?.slice(0, 500)
          : String(error).slice(0, 500),
      teamId: input.teamId,
      threadId: input.threadId,
      userMessageId: input.userMessageId,
      workspaceId: input.workspaceId,
    });
    const fallback = buildFallbackSpec(input);
    return fallback;
  }
}

export const testExports = {
  buildFallbackSpec,
  extractJsonObject,
  looksLikeCreativeDirection,
  plannerResponseSchema,
  resolveTheme,
  sanitizePlannedContent,
};
