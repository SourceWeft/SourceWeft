import { z } from "zod";

export const videoPresentationSceneTypeSchema = z.enum([
  "title",
  "content",
  "comparison",
  "timeline",
  "metric",
  "quote",
  "process",
  "image-led",
  "closing",
]);

export const videoPresentationCompositionSchema = z.enum([
  "cinematic",
  "split",
  "stacked",
  "radial",
  "data-wall",
]);

export const videoPresentationMoodSchema = z.enum([
  "executive",
  "technical",
  "editorial",
  "energetic",
  "calm",
  "dramatic",
]);

export const videoPresentationMotionSchema = z.object({
  camera: z.enum(["none", "slow-push", "pan", "parallax"]).default("slow-push"),
  emphasis: z.enum(["none", "pulse", "underline", "spotlight"]).default("spotlight"),
  entrance: z.enum(["fade", "rise", "wipe", "scale"]).default("rise"),
  transition: z.enum(["cut", "fade", "slide", "curtain"]).default("fade"),
});

export const videoPresentationThemeSchema = z.object({
  background: z.string().trim().min(1).max(80).default("#0b1017"),
  foreground: z.string().trim().min(1).max(80).default("#f8fafc"),
  accent: z.string().trim().min(1).max(80).default("#38bdf8"),
  secondary: z.string().trim().min(1).max(80).default("#a78bfa"),
  muted: z.string().trim().min(1).max(80).default("#94a3b8"),
  fontFamily: z.string().trim().min(1).max(120).default("Inter, sans-serif"),
});

export const videoPresentationMetricSchema = z.object({
  label: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(80),
  delta: z.string().trim().max(80).optional(),
});

export const videoPresentationTimelineItemSchema = z.object({
  label: z.string().trim().min(1).max(80),
  detail: z.string().trim().max(180).optional(),
});

export const videoPresentationSceneSchema = z.object({
  slideNumber: z.number().int().min(1).max(80),
  sceneType: videoPresentationSceneTypeSchema,
  composition: videoPresentationCompositionSchema.default("cinematic"),
  mood: videoPresentationMoodSchema.default("editorial"),
  title: z.string().trim().min(1).max(180),
  subtitle: z.string().trim().max(260).optional(),
  kicker: z.string().trim().max(120).optional(),
  bullets: z.array(z.string().trim().min(1).max(220)).max(6).default([]),
  quote: z.string().trim().max(360).optional(),
  metrics: z.array(videoPresentationMetricSchema).max(4).default([]),
  timeline: z.array(videoPresentationTimelineItemSchema).max(6).default([]),
  visualPrompt: z.string().trim().max(500).optional(),
  motion: videoPresentationMotionSchema.default({
    camera: "slow-push",
    emphasis: "spotlight",
    entrance: "rise",
    transition: "fade",
  }),
});

export const videoPresentationSlideSchema = z.object({
  slideNumber: z.number().int().min(1).max(80),
  title: z.string().trim().min(1).max(180),
  subtitle: z.string().trim().max(260).optional(),
  contentMarkdown: z.string().trim().max(1600).optional(),
  speakerTranscript: z.array(z.string().trim().min(1).max(360)).min(1).max(6),
  backgroundDirection: z.string().trim().max(500).optional(),
});

export const videoPresentationAudioTrackSchema = z.object({
  assetUrl: z.string().trim().min(1),
  durationSeconds: z.number().min(0),
  fileName: z.string().trim().min(1),
  mimeType: z.string().trim().min(1),
  slideNumber: z.number().int().min(1),
  storageBucket: z.string().trim().min(1).optional(),
  storageKey: z.string().trim().min(1),
});

export const videoPresentationSpecSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1).max(180),
  fps: z.number().int().min(12).max(60).default(30),
  width: z.number().int().min(640).max(3840).default(1920),
  height: z.number().int().min(360).max(2160).default(1080),
  theme: videoPresentationThemeSchema.default({
    background: "#0b1017",
    foreground: "#f8fafc",
    accent: "#38bdf8",
    secondary: "#a78bfa",
    muted: "#94a3b8",
    fontFamily: "Inter, sans-serif",
  }),
  slides: z.array(videoPresentationSlideSchema).min(1).max(40),
  scenes: z.array(videoPresentationSceneSchema).min(1).max(40),
  narrationEnabled: z.boolean().default(true),
  audioTracks: z.array(videoPresentationAudioTrackSchema).default([]),
});

export type VideoPresentationSceneType = z.infer<
  typeof videoPresentationSceneTypeSchema
>;
export type VideoPresentationComposition = z.infer<
  typeof videoPresentationCompositionSchema
>;
export type VideoPresentationMood = z.infer<typeof videoPresentationMoodSchema>;
export type VideoPresentationMotion = z.infer<
  typeof videoPresentationMotionSchema
>;
export type VideoPresentationTheme = z.infer<typeof videoPresentationThemeSchema>;
export type VideoPresentationScene = z.infer<typeof videoPresentationSceneSchema>;
export type VideoPresentationSlide = z.infer<typeof videoPresentationSlideSchema>;
export type VideoPresentationAudioTrack = z.infer<
  typeof videoPresentationAudioTrackSchema
>;
export type VideoPresentationSpec = z.infer<typeof videoPresentationSpecSchema>;
