import { z } from "zod";

export const VIDEO_PRESENTATION_WORKFLOW_VERSION =
  "video-presentation-agent" as const;
export const VIDEO_PRESENTATION_BUILDER_VERSION = "remotion-project" as const;
export const VIDEO_PRESENTATION_NARRATION_TAIL_PADDING_SECONDS = 0.75;

export const videoPresentationAssetTypeSchema = z.enum([
  "hero",
  "editorial_illustration",
  "scene_background",
  "abstract_texture",
  "diagrammatic_visual",
]);

export const videoPresentationRenderProfileSchema = z
  .object({
    stylePreset: z.enum([
      "cinematic",
      "editorial",
      "executive",
      "technical",
      "product",
    ]),
    visualDensity: z.enum(["light", "balanced", "dense"]),
    durationTarget: z.enum(["short", "medium", "long"]),
    language: z.string().trim().min(1).max(20),
  })
  .strict();

export const videoPresentationResolvedRenderProfileSchema =
  videoPresentationRenderProfileSchema;

export const videoPresentationCanvasSchema = z
  .object({
    width: z.number().int().min(640).max(3840).optional(),
    height: z.number().int().min(360).max(2160).optional(),
    fps: z.number().int().min(12).max(60).optional(),
  })
  .strict();

export const videoPresentationBrandSchema = z
  .object({
    colors: z.array(z.string().trim().min(1).max(80)).max(8).optional(),
    typography: z.string().trim().min(1).max(160).optional(),
    logoAssetId: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export const videoPresentationMotionSchema = z
  .object({
    pacing: z.enum(["calm", "dynamic", "energetic"]).optional(),
    transitionStyle: z.string().trim().min(1).max(160).optional(),
    animationIntensity: z.enum(["subtle", "balanced", "bold"]).optional(),
  })
  .strict();

export const videoPresentationProjectSchema = z
  .object({
    title: z.string().trim().min(1).max(180),
    fps: z.number().int().min(12).max(60),
    width: z.number().int().min(640).max(3840),
    height: z.number().int().min(360).max(2160),
    durationSeconds: z.number().positive(),
    stylePreset: videoPresentationRenderProfileSchema.shape.stylePreset,
    globalVisualDirection: z.string().trim().min(1).max(1000),
    brand: videoPresentationBrandSchema.optional(),
    motion: videoPresentationMotionSchema.optional(),
  })
  .strict();

export const videoPresentationAssetRefSchema = z
  .object({
    assetId: z.string().trim().min(1).max(160),
    role: z.string().trim().min(1).max(80),
  })
  .strict();

export const videoPresentationSlideSchema = z
  .object({
    slideNumber: z.number().int().min(1).max(12),
    title: z.string().trim().min(1).max(180),
    subtitle: z.string().trim().max(260).optional(),
    contentMarkdown: z.string().trim().max(4000).optional(),
    speakerTranscript: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
    backgroundExplanation: z.string().trim().max(1000).optional(),
    sceneIntent: z.string().trim().min(1).max(2000),
    assetRefs: z.array(videoPresentationAssetRefSchema).default([]),
    assetNeeds: z.array(z.string().trim().min(1).max(80)).max(4).default([]),
  })
  .strict();

const contentDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const videoPresentationAudioFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:aac|m4a|mp3|ogg|wav|webm)$/iu,
    "Audio fileName must be a flat audio basename",
  );

export const videoPresentationAudioTrackSchema = z
  .object({
    slideNumber: z.number().int().min(1).max(12),
    assetUrl: z.string().trim().min(1),
    storageKey: z.string().trim().min(1),
    storageBucket: z.string().trim().min(1),
    durationSeconds: z.number().positive(),
    mimeType: z.string().trim().min(1),
    contentDigest: contentDigestSchema,
    contentType: z.string().trim().min(1),
    fileName: videoPresentationAudioFileNameSchema,
  })
  .strict();

const committedMediaSchema = z
  .object({
    assetUrl: z.string().trim().min(1),
    storageKey: z.string().trim().min(1),
    storageBucket: z.string().trim().min(1),
    fileName: z.string().trim().min(1).max(240),
    byteLength: z.number().int().positive(),
    contentDigest: contentDigestSchema,
  })
  .strict();

export const videoPresentationRenderedVideoSchema = committedMediaSchema
  .extend({
    mimeType: z.literal("video/mp4"),
    durationInFrames: z.number().int().positive(),
    fps: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    hasAudio: z.boolean(),
  })
  .strict();

export const videoPresentationCoverImageSchema = committedMediaSchema
  .extend({
    mimeType: z.literal("image/jpeg"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    slideNumber: z.number().int().min(1).max(12),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();

export const videoPresentationSceneModuleSchema = z
  .object({
    slideNumber: z.number().int().min(1).max(12),
    title: z.string().trim().min(1).max(180),
    code: z.string().trim().min(1),
    componentName: z.literal("VideoScene").default("VideoScene"),
    durationInFrames: z.number().int().positive(),
    diagnostics: z.array(z.string().trim().min(1).max(1000)).default([]),
    layoutWarnings: z.array(z.string().trim().min(1).max(1000)).default([]),
    compileStatus: z.enum(["compiled", "repaired"]).default("compiled"),
  })
  .strict();

export const videoPresentationAssetSchema = z
  .object({
    assetId: z.string().trim().min(1).max(160),
    type: videoPresentationAssetTypeSchema,
    prompt: z.string().trim().min(1).max(4000),
    fileName: z.string().trim().min(1).max(240),
    storageKey: z.string().trim().min(1),
    storageBucket: z.string().trim().min(1),
    sourceUrl: z.string().trim().min(1),
    contentDigest: contentDigestSchema,
    contentType: z.string().trim().min(1),
    slideNumbers: z.array(z.number().int().min(1).max(12)).min(1).max(12),
    source: z.enum(["generated", "provided"]),
  })
  .strict();

export const videoPresentationPreviewSchema = z
  .object({
    slideCount: z.number().int().min(1).max(12),
    durationSeconds: z.number().positive(),
  })
  .strict();

export const videoPresentationProjectExecutionResultSchema = z
  .object({
    ok: z.boolean(),
    diagnostics: z.array(z.string().trim().min(1).max(2000)).max(50),
    stdout: z.string().max(10_000).optional(),
    stderr: z.string().max(10_000).optional(),
  })
  .strict();

export const videoPresentationProjectCodeSchema = z
  .object({
    install: videoPresentationProjectExecutionResultSchema,
    typecheck: videoPresentationProjectExecutionResultSchema,
    smoke: videoPresentationProjectExecutionResultSchema.extend({
      checked: z.boolean(),
    }),
  })
  .strict();

export const videoPresentationNarrationPolicySchema = z
  .object({ enabled: z.boolean() })
  .strict();

export const videoPresentationDraftResourceRefSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("local"),
        sandboxPath: z.string().trim().min(1).max(1000),
        blobRef: z.string().trim().min(1).max(500),
        contentDigest: contentDigestSchema,
        contentType: z.string().trim().min(1).max(200),
      })
      .strict(),
    z
      .object({
        kind: z.literal("committed"),
        resourceHandle: z.string().trim().min(1).max(500),
        contentDigest: contentDigestSchema,
        contentType: z.string().trim().min(1).max(200),
      })
      .strict(),
  ],
);

export const videoPresentationDraftAudioTrackSchema = z
  .object({
    slideNumber: z.number().int().min(1).max(12),
    durationSeconds: z.number().positive(),
    mimeType: z.string().trim().min(1),
    fileName: videoPresentationAudioFileNameSchema,
    resource: videoPresentationDraftResourceRefSchema,
  })
  .strict();

export const videoPresentationDraftAssetSchema = z
  .object({
    assetId: z.string().trim().min(1).max(160),
    type: videoPresentationAssetTypeSchema,
    prompt: z.string().trim().min(1).max(4000),
    slideNumbers: z.array(z.number().int().min(1).max(12)).min(1).max(12),
    source: z.enum(["generated", "provided"]),
    resource: videoPresentationDraftResourceRefSchema,
  })
  .strict();

function addNarrationCoverageIssues(
  value: {
    narrationPolicy: { enabled: boolean };
    slides: readonly { slideNumber: number }[];
    audioTracks: readonly { slideNumber: number }[];
  },
  context: z.RefinementCtx,
) {
  const slideNumbers = new Set(value.slides.map((slide) => slide.slideNumber));
  const counts = new Map<number, number>();
  for (const track of value.audioTracks) {
    counts.set(track.slideNumber, (counts.get(track.slideNumber) ?? 0) + 1);
  }
  if (!value.narrationPolicy.enabled && value.audioTracks.length > 0) {
    context.addIssue({
      code: "custom",
      message: "Narration-disabled payloads must not contain audio tracks",
      path: ["audioTracks"],
      input: value,
    });
  }
  if (value.narrationPolicy.enabled) {
    for (const slideNumber of slideNumbers) {
      if (counts.get(slideNumber) !== 1) {
        context.addIssue({
          code: "custom",
          message: `Narration requires exactly one track for slide ${slideNumber}`,
          path: ["audioTracks"],
          input: value,
        });
      }
    }
  }
  value.audioTracks.forEach((track, index) => {
    if (!slideNumbers.has(track.slideNumber)) {
      context.addIssue({
        code: "custom",
        message: `Audio track references unknown slide ${track.slideNumber}`,
        path: ["audioTracks", index, "slideNumber"],
        input: track,
      });
    }
  });
}

const projectSemanticsSchema = z.object({
  narrationPolicy: videoPresentationNarrationPolicySchema,
  project: videoPresentationProjectSchema,
  slides: z.array(videoPresentationSlideSchema).min(1).max(12),
  sceneModules: z.array(videoPresentationSceneModuleSchema).max(12),
  renderProfile: videoPresentationResolvedRenderProfileSchema,
  themeAssignments: z
    .array(
      z
        .object({
          slideNumber: z.number().int().min(1).max(12),
          themeName: z.string().trim().min(1).max(80),
          mode: z.enum(["dark", "light"]),
        })
        .strict(),
    )
    .max(12),
  sourceDigest: z.string().trim().min(1).max(50_000),
});

export const videoPresentationDraftPayloadSchema = projectSemanticsSchema
  .extend({
    schemaVersion: z.literal(1),
    kind: z.literal("video_presentation_draft"),
    workflowVersion: z.literal(VIDEO_PRESENTATION_WORKFLOW_VERSION),
    builderVersion: z.literal(VIDEO_PRESENTATION_BUILDER_VERSION),
    audioTracks: z.array(videoPresentationDraftAudioTrackSchema).max(12),
    assets: z.array(videoPresentationDraftAssetSchema).max(48),
  })
  .strict()
  .superRefine(addNarrationCoverageIssues);

export type VideoPresentationDraftValidationMode =
  | { readonly mode: "create" }
  | {
      readonly mode: "edit";
      readonly authorizedResourceHandles: ReadonlySet<string>;
    };

export function videoPresentationDraftPayloadSchemaForMode(
  validation: VideoPresentationDraftValidationMode,
) {
  return videoPresentationDraftPayloadSchema.superRefine((draft, context) => {
    const resources = [
      ...draft.audioTracks.map((track, index) => ({
        path: ["audioTracks", index, "resource"] as PropertyKey[],
        resource: track.resource,
      })),
      ...draft.assets.map((asset, index) => ({
        path: ["assets", index, "resource"] as PropertyKey[],
        resource: asset.resource,
      })),
    ];
    for (const entry of resources) {
      if (entry.resource.kind !== "committed") continue;
      if (validation.mode === "create") {
        context.addIssue({
          code: "custom",
          message: "Create drafts cannot contain committed resource handles",
          path: entry.path,
          input: entry.resource,
        });
      } else if (
        !validation.authorizedResourceHandles.has(entry.resource.resourceHandle)
      ) {
        context.addIssue({
          code: "custom",
          message: `Committed resource handle '${entry.resource.resourceHandle}' is not authorized`,
          path: entry.path,
          input: entry.resource,
        });
      }
    }
  });
}

export function parseVideoPresentationDraftPayload(
  input: unknown,
  validation: VideoPresentationDraftValidationMode,
) {
  return videoPresentationDraftPayloadSchemaForMode(validation).parse(input);
}

export const videoPresentationRenderableProjectSchema = projectSemanticsSchema
  .extend({
    sceneModules: z.array(videoPresentationSceneModuleSchema).min(1).max(12),
    audioTracks: z.array(videoPresentationAudioTrackSchema).max(12),
    assets: z.array(videoPresentationAssetSchema).max(48),
    preview: videoPresentationPreviewSchema,
  })
  .strict()
  .superRefine(addNarrationCoverageIssues);

export const videoPresentationProjectPayloadSchema = projectSemanticsSchema
  .extend({
    schemaVersion: z.literal(1),
    kind: z.literal("video_presentation"),
    requestKey: z.string().trim().min(1).max(300),
    workflowVersion: z.literal(VIDEO_PRESENTATION_WORKFLOW_VERSION),
    builderVersion: z.literal(VIDEO_PRESENTATION_BUILDER_VERSION),
    sceneModules: z.array(videoPresentationSceneModuleSchema).min(1).max(12),
    audioTracks: z.array(videoPresentationAudioTrackSchema).max(12),
    assets: z.array(videoPresentationAssetSchema).max(48),
    preview: videoPresentationPreviewSchema,
    renderedVideo: videoPresentationRenderedVideoSchema,
    coverImage: videoPresentationCoverImageSchema,
    projectCode: videoPresentationProjectCodeSchema,
  })
  .strict()
  .superRefine(addNarrationCoverageIssues);

export const videoPresentationCommittedPayloadSchema =
  videoPresentationProjectPayloadSchema;

export type VideoPresentationAssetType = z.infer<
  typeof videoPresentationAssetTypeSchema
>;
export type VideoPresentationRenderProfile = z.infer<
  typeof videoPresentationRenderProfileSchema
>;
export type VideoPresentationResolvedRenderProfile = z.infer<
  typeof videoPresentationResolvedRenderProfileSchema
>;
export type VideoPresentationProject = z.infer<
  typeof videoPresentationProjectSchema
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
export type VideoPresentationRenderedVideo = z.infer<
  typeof videoPresentationRenderedVideoSchema
>;
export type VideoPresentationCoverImage = z.infer<
  typeof videoPresentationCoverImageSchema
>;
export type VideoPresentationProjectExecutionResult = z.infer<
  typeof videoPresentationProjectExecutionResultSchema
>;
export type VideoPresentationAsset = z.infer<
  typeof videoPresentationAssetSchema
>;
export type VideoPresentationPreview = z.infer<
  typeof videoPresentationPreviewSchema
>;
export type VideoPresentationDraftResourceRef = z.infer<
  typeof videoPresentationDraftResourceRefSchema
>;
export type VideoPresentationDraftAudioTrack = z.infer<
  typeof videoPresentationDraftAudioTrackSchema
>;
export type VideoPresentationDraftAsset = z.infer<
  typeof videoPresentationDraftAssetSchema
>;
export type VideoPresentationDraftPayload = z.infer<
  typeof videoPresentationDraftPayloadSchema
>;
export type VideoPresentationRenderableProject = z.infer<
  typeof videoPresentationRenderableProjectSchema
>;
export type VideoPresentationProjectPayload = z.infer<
  typeof videoPresentationProjectPayloadSchema
>;
export type VideoPresentationCommittedPayload = VideoPresentationProjectPayload;
