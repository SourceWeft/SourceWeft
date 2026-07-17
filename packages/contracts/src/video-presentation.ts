import { z } from "zod";

export const videoPresentationGenerationStatusSchema = z.enum([
  "pending",
  "running",
  "ready",
  "failed",
]);

export const videoPresentationGenerationStageSchema = z.enum([
  "planning",
  "generating_project_code",
  "installing_project",
  "typechecking_project",
  "rendering_smoke_preview",
  "planning_storyboard",
  "materializing_assets",
  "generating_audio_tracks",
  "assigning_slide_themes",
  "generating_scene_modules",
  "repairing_scene_modules",
  "publishing_video_project",
  "failed",
  "ready",
]);

export const videoPresentationAssetTypeSchema = z.enum([
  "hero",
  "editorial_illustration",
  "scene_background",
  "abstract_texture",
  "diagrammatic_visual",
]);

export const videoPresentationThemeModeSchema = z.enum(["dark", "light"]);

export const videoPresentationRenderProfileSchema = z.object({
  stylePreset: z
    .enum(["cinematic", "editorial", "executive", "technical", "product"])
    .default("cinematic"),
  visualDensity: z.enum(["light", "balanced", "dense"]).default("balanced"),
  durationTarget: z.enum(["short", "medium", "long"]).default("medium"),
  language: z.string().trim().min(1).max(20).default("auto"),
});

export const videoPresentationCanvasSchema = z.object({
  width: z.number().int().min(640).max(3840).optional(),
  height: z.number().int().min(360).max(2160).optional(),
  fps: z.number().int().min(12).max(60).optional(),
});

export const videoPresentationBrandSchema = z.object({
  colors: z.array(z.string().trim().min(1).max(80)).max(8).optional(),
  typography: z.string().trim().min(1).max(160).optional(),
  logoAssetId: z.string().trim().min(1).max(160).optional(),
});

export const videoPresentationMotionSchema = z.object({
  pacing: z.enum(["calm", "dynamic", "energetic"]).optional(),
  transitionStyle: z.string().trim().min(1).max(160).optional(),
  animationIntensity: z.enum(["subtle", "balanced", "bold"]).optional(),
});

export const videoPresentationBriefRequestSchema = z
  .object({
    brief: z.string().trim().max(50_000).optional(),
    title: z.string().trim().min(1).max(180).optional(),
    language: z.string().trim().min(1).max(20).optional(),
    durationTarget:
      videoPresentationRenderProfileSchema.shape.durationTarget.optional(),
    stylePreset:
      videoPresentationRenderProfileSchema.shape.stylePreset.optional(),
    sourceDigest: z.string().trim().max(50_000).optional(),
    audience: z.string().trim().max(300).optional(),
    tone: z.string().trim().max(200).optional(),
    narrationEnabled: z.boolean().optional(),
  })
  .passthrough();

export const videoPresentationThemeAssignmentSchema = z.object({
  slideNumber: z.number().int().min(1).max(80),
  themeName: z.string().trim().min(1).max(80),
  mode: videoPresentationThemeModeSchema.default("dark"),
});

export const videoPresentationGenerationSchema = z.object({
  status: videoPresentationGenerationStatusSchema.default("pending"),
  stage: videoPresentationGenerationStageSchema.default("planning"),
  progress: z.number().min(0).max(100).default(0),
  attempt: z.number().int().min(1).optional(),
  maxAttempts: z.number().int().min(1).optional(),
  retrying: z.boolean().optional(),
  errorCode: z.string().trim().min(1).max(120).optional(),
  errorMessage: z.string().trim().min(1).max(1000).optional(),
});

export const videoPresentationProjectSchema = z.object({
  title: z.string().trim().min(1).max(180),
  fps: z.number().int().min(12).max(60).default(30),
  width: z.number().int().min(640).max(3840).default(1920),
  height: z.number().int().min(360).max(2160).default(1080),
  durationSeconds: z.number().min(0).default(0),
  stylePreset: videoPresentationRenderProfileSchema.shape.stylePreset,
  globalVisualDirection: z.string().trim().min(1).max(1000),
});

export const videoPresentationAssetRefSchema = z.object({
  assetId: z.string().trim().min(1).max(160),
  role: z.string().trim().min(1).max(80),
});

export const videoPresentationSlideSchema = z.object({
  slideNumber: z.number().int().min(1).max(80),
  title: z.string().trim().min(1).max(180),
  subtitle: z.string().trim().max(260).optional(),
  contentMarkdown: z.string().trim().max(4000).optional(),
  speakerTranscript: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
  backgroundExplanation: z.string().trim().max(1000).optional(),
  sceneIntent: z.string().trim().min(1).max(2000),
  assetRefs: z.array(videoPresentationAssetRefSchema).default([]),
});

export const videoPresentationAudioTrackSchema = z.object({
  slideNumber: z.number().int().min(1).max(80),
  assetUrl: z.string().trim().min(1),
  storageKey: z.string().trim().min(1),
  storageBucket: z.string().trim().min(1).optional(),
  durationSeconds: z.number().min(0),
  mimeType: z.string().trim().min(1),
  fileName: z.string().trim().min(1),
});

export const videoPresentationSceneModuleSchema = z.object({
  slideNumber: z.number().int().min(1).max(80),
  title: z.string().trim().min(1).max(180),
  code: z.string().trim().min(1),
  componentName: z.string().trim().min(1).max(120).default("VideoScene"),
  durationInFrames: z.number().int().min(1),
  repairAttempts: z.number().int().min(0).max(10).default(0),
  diagnostics: z.array(z.string().trim().min(1).max(1000)).default([]),
  compileStatus: z
    .enum(["pending", "compiled", "repaired", "failed"])
    .default("pending"),
});

export const videoPresentationAssetSchema = z.object({
  assetId: z.string().trim().min(1).max(160),
  type: videoPresentationAssetTypeSchema,
  prompt: z.string().trim().min(1).max(4000),
  storageKey: z.string().trim().min(1),
  storageBucket: z.string().trim().min(1).optional(),
  sourceUrl: z.string().trim().min(1).optional(),
  slideNumbers: z.array(z.number().int().min(1).max(80)).min(1).max(80),
  source: z.enum(["generated", "provided", "fallback"]).default("generated"),
});

export const videoPresentationPreviewSchema = z.object({
  coverImageUrl: z.string().trim().min(1).optional(),
  slideCount: z.number().int().min(0).default(0),
  durationSeconds: z.number().min(0).default(0),
});

const videoPresentationProjectExecutionResultSchema = z.object({
  ok: z.boolean().default(false),
  diagnostics: z.array(z.string().trim().min(1).max(2000)).default([]),
  stdout: z.string().trim().max(10_000).optional(),
  stderr: z.string().trim().max(10_000).optional(),
});

export const videoPresentationAssetPlanItemSchema = z.object({
  assetId: z.string().trim().min(1).max(160),
  slideNumber: z.number().int().min(1).max(80),
  type: videoPresentationAssetTypeSchema,
  role: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(4000),
});

export const videoPresentationCreateRequestSchema = z.object({
  brief: z.string().trim().max(50_000).optional(),
  title: z.string().trim().min(1).max(180).optional(),
  sourceDigest: z.string().trim().max(50_000).optional(),
  audience: z.string().trim().max(300).optional(),
  tone: z.string().trim().max(200).optional(),
  language: z.string().trim().min(1).max(20).optional(),
  durationTarget:
    videoPresentationRenderProfileSchema.shape.durationTarget.optional(),
  stylePreset:
    videoPresentationRenderProfileSchema.shape.stylePreset.optional(),
  renderProfile: videoPresentationRenderProfileSchema.partial().optional(),
  slideCount: z.number().int().min(1).max(12).optional(),
  visualDirection: z.string().trim().min(1).max(1000).optional(),
  brand: videoPresentationBrandSchema.optional(),
  motion: videoPresentationMotionSchema.optional(),
  canvas: videoPresentationCanvasSchema.optional(),
  narrationEnabled: z.boolean().optional(),
  narration: z
    .object({
      enabled: z.boolean().default(true),
    })
    .optional(),
  assets: z.array(videoPresentationAssetRefSchema).default([]),
  regeneration: z
    .object({
      artifactId: z.string().trim().min(1).max(160).optional(),
      instruction: z.string().trim().max(4000).optional(),
      slideNumbers: z.array(z.number().int().min(1).max(80)).max(80).optional(),
    })
    .optional(),
});

export const videoPresentationProjectPayloadSchema = z.object({
  schemaVersion: z.literal(2),
  kind: z.literal("video_presentation"),
  generation: videoPresentationGenerationSchema,
  project: videoPresentationProjectSchema,
  slides: z.array(videoPresentationSlideSchema).min(1).max(40),
  audioTracks: z.array(videoPresentationAudioTrackSchema).default([]),
  sceneModules: z.array(videoPresentationSceneModuleSchema).default([]),
  assets: z.array(videoPresentationAssetSchema).default([]),
  preview: videoPresentationPreviewSchema.default({
    slideCount: 0,
    durationSeconds: 0,
  }),
  renderProfile: videoPresentationRenderProfileSchema,
  themeAssignments: z.array(videoPresentationThemeAssignmentSchema).default([]),
  sourceDigest: z.string().trim().min(1).max(50_000),
  projectCode: z
    .object({
      entryFile: z
        .string()
        .trim()
        .min(1)
        .max(240)
        .default("src/VideoScene.tsx"),
      files: z
        .array(
          z.object({
            path: z.string().trim().min(1).max(240),
            content: z.string().trim().min(1),
          }),
        )
        .default([]),
      install: videoPresentationProjectExecutionResultSchema.default({
        ok: false,
        diagnostics: [],
      }),
      typecheck: videoPresentationProjectExecutionResultSchema.default({
        ok: false,
        diagnostics: [],
      }),
      smoke: z
        .object({
          checked: z.boolean().default(false),
          ...videoPresentationProjectExecutionResultSchema.shape,
        })
        .default({ checked: false, ok: false, diagnostics: [] }),
    })
    .optional(),
});

export type VideoPresentationGenerationStatus = z.infer<
  typeof videoPresentationGenerationStatusSchema
>;
export type VideoPresentationGenerationStage = z.infer<
  typeof videoPresentationGenerationStageSchema
>;
export type VideoPresentationAssetType = z.infer<
  typeof videoPresentationAssetTypeSchema
>;
export type VideoPresentationThemeMode = z.infer<
  typeof videoPresentationThemeModeSchema
>;
export type VideoPresentationRenderProfile = z.infer<
  typeof videoPresentationRenderProfileSchema
>;
export type VideoPresentationCanvas = z.infer<
  typeof videoPresentationCanvasSchema
>;
export type VideoPresentationBrand = z.infer<
  typeof videoPresentationBrandSchema
>;
export type VideoPresentationMotion = z.infer<
  typeof videoPresentationMotionSchema
>;
export type VideoPresentationThemeAssignment = z.infer<
  typeof videoPresentationThemeAssignmentSchema
>;
export type VideoPresentationGeneration = z.infer<
  typeof videoPresentationGenerationSchema
>;
export type VideoPresentationProject = z.infer<
  typeof videoPresentationProjectSchema
>;
export type VideoPresentationAssetRef = z.infer<
  typeof videoPresentationAssetRefSchema
>;
export type VideoPresentationSlide = z.infer<
  typeof videoPresentationSlideSchema
>;
export type VideoPresentationAudioTrack = z.infer<
  typeof videoPresentationAudioTrackSchema
>;
export type VideoPresentationSceneModule = z.infer<
  typeof videoPresentationSceneModuleSchema
>;
export type VideoPresentationAsset = z.infer<
  typeof videoPresentationAssetSchema
>;
export type VideoPresentationPreview = z.infer<
  typeof videoPresentationPreviewSchema
>;
export type VideoPresentationAssetPlanItem = z.infer<
  typeof videoPresentationAssetPlanItemSchema
>;
export type VideoPresentationCreateRequest = z.infer<
  typeof videoPresentationCreateRequestSchema
>;
export type VideoPresentationProjectPayload = z.infer<
  typeof videoPresentationProjectPayloadSchema
>;
