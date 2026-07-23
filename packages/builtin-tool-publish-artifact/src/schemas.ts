import { z } from "zod";

export const SandboxPathSourceSchema = z.object({
  kind: z.literal("sandbox_path"),
  path: z
    .string()
    .min(1)
    .describe(
      "Absolute path inside the active sandbox, for example /workspace/Presentation.pptx.",
    ),
});

export const WorkFileSourceSchema = z.object({
  kind: z.literal("work_file"),
  path: z
    .string()
    .min(1)
    .describe("SourceWeft /workfiles path for an already-existing file."),
});

export const ArtifactSourceSchema = z.discriminatedUnion("kind", [
  SandboxPathSourceSchema,
  WorkFileSourceSchema,
]);

export type ArtifactSource = z.infer<typeof ArtifactSourceSchema>;

export const PreviewImageInputSchema = z.object({
  source: ArtifactSourceSchema,
  altText: z.string().optional(),
});

export type PreviewImageInput = z.infer<typeof PreviewImageInputSchema>;

export const PublishArtifactTypeSchema = z.enum(["slides", "file"]);
export type PublishArtifactType = z.infer<typeof PublishArtifactTypeSchema>;

export const QaSummarySchema = z.object({
  contentChecked: z.boolean().default(false),
  visualChecked: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
});

export const PublishArtifactInputSchema = z
  .object({
    artifactType: PublishArtifactTypeSchema.describe(
      "File artifact type to publish. Supported: slides for PPTX decks, file for generic downloadable files.",
    ),
    title: z
      .string()
      .min(1)
      .describe("Artifact title for metadata."),
    description: z.string().optional(),
    source: ArtifactSourceSchema,
    previewImage: PreviewImageInputSchema.optional()
      .describe(
        "Required preview image for slides artifacts, usually PREVIEW_IMAGE_PATH from final PPTX visual QA.",
      ),
    qa: QaSummarySchema.optional(),
    republishArtifactId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Publish as a new version of this existing ready artifact instead of creating a new one. Use when editing a previously published artifact.",
      ),
  })
  .superRefine((value, ctx) => {
    if (value.artifactType === "slides" && !value.previewImage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "is required for slides artifacts; use PREVIEW_IMAGE_PATH from final PPTX visual QA",
        path: ["previewImage"],
      });
    }
    if (value.previewImage && value.artifactType !== "slides") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "previewImage is only supported for slides artifacts",
        path: ["previewImage"],
      });
    }
  });

export type PublishArtifactInput = z.infer<typeof PublishArtifactInputSchema>;

const ToolSourceSchema = z.union([
  ArtifactSourceSchema,
  z
    .object({
      kind: z.unknown().optional(),
      path: z.unknown().optional(),
    })
    .passthrough(),
  z.string(),
  z.null(),
]);

const ToolQaSchema = z.union([
  QaSummarySchema,
  z
    .object({
      contentChecked: z.unknown().optional(),
      visualChecked: z.unknown().optional(),
      warnings: z.unknown().optional(),
    })
    .passthrough(),
  z.null(),
]);

const ToolPreviewImageSchema = z.union([
  PreviewImageInputSchema,
  z
    .object({
      source: ToolSourceSchema.optional(),
      altText: z.unknown().optional(),
    })
    .passthrough(),
  z.null(),
]);

export const PublishArtifactToolInputSchema = z.object({
  artifactType: z
    .string()
    .optional()
    .describe(
      "File artifact type to publish. Use slides for PPTX decks or file for generic downloadable files.",
    ),
  title: z
    .string()
    .optional()
    .describe("Artifact title for metadata."),
  description: z.string().optional(),
  source: ToolSourceSchema.optional()
    .describe(
      "Structured source object, for example { kind: 'sandbox_path', path: '/workspace/Presentation.pptx' } or { kind: 'work_file', path: '/workfiles/deck.pptx' }.",
    ),
  sourceKind: z.unknown().optional()
    .describe("Flat source kind fallback: sandbox_path or work_file."),
  sourcePath: z.unknown().optional()
    .describe("Flat source path fallback, for example /workspace/output.zip."),
  previewImage: ToolPreviewImageSchema.optional()
    .describe(
      "Required for slides. Use PREVIEW_IMAGE_PATH from final PPTX visual QA, for example { source: { kind: 'sandbox_path', path: '/workspace/qa/preview.jpg' }, altText: 'First slide preview' }.",
    ),
  qa: ToolQaSchema.optional(),
  republishArtifactId: z
    .string()
    .optional()
    .describe(
      "When editing an already-published artifact, its id — the edit publishes as a new version of the same artifact. Omit for new artifacts.",
    ),
});

export type PublishArtifactToolInput = z.infer<
  typeof PublishArtifactToolInputSchema
>;

export const PublishSlidesArtifactOutputSchema = z.object({
  ok: z.literal(true),
  type: z.literal("presentation_artifact_result"),
  status: z.literal("ready"),
  artifactId: z.string(),
  artifact_id: z.string(),
  artifactType: z.literal("slides"),
  title: z.string(),
  fileName: z.string(),
  file_name: z.string(),
  byteLength: z.number().int().positive(),
  byte_length: z.number().int().positive(),
  editable: z.literal(true),
  generation_mode: z.literal("editable_native"),
  artifactUrl: z.string(),
  artifact_url: z.string(),
  pptx_url: z.string(),
  previewImageUrl: z.string().optional(),
  preview_image_url: z.string().optional(),
  qaWarnings: z.array(z.string()),
});

export const PublishFileArtifactOutputSchema = z.object({
  ok: z.literal(true),
  type: z.literal("file_artifact_result"),
  status: z.literal("ready"),
  artifactId: z.string(),
  artifact_id: z.string(),
  artifactType: z.literal("file"),
  title: z.string(),
  fileName: z.string(),
  file_name: z.string(),
  mimeType: z.string(),
  mime_type: z.string(),
  byteLength: z.number().int().positive(),
  byte_length: z.number().int().positive(),
  artifactUrl: z.string(),
  artifact_url: z.string(),
  downloadUrl: z.string(),
  download_url: z.string(),
});

export const PublishImageArtifactOutputSchema = z.object({
  ok: z.literal(true),
  type: z.literal("generated_image"),
  status: z.literal("ready"),
  artifactId: z.string(),
  artifact_id: z.string(),
  artifactType: z.literal("image"),
  title: z.string(),
  fileName: z.string(),
  file_name: z.string(),
  mimeType: z.string(),
  mime_type: z.string(),
  byteLength: z.number().int().positive(),
  byte_length: z.number().int().positive(),
  artifactUrl: z.string(),
  artifact_url: z.string(),
});

export const PublishArtifactOutputSchema = z.union([
  PublishSlidesArtifactOutputSchema,
  PublishFileArtifactOutputSchema,
  PublishImageArtifactOutputSchema,
]);

export type PublishArtifactSuccessOutput = z.infer<
  typeof PublishArtifactOutputSchema
>;

export const ARTIFACT_PUBLISH_ERROR_CODES = [
  "PUBLISH_INPUT_INVALID",
  "ARTIFACT_REPUBLISH_INVALID",
  "ARTIFACT_TYPE_UNSUPPORTED",
  "ARTIFACT_SOURCE_UNAVAILABLE",
  "ARTIFACT_SOURCE_NOT_FOUND",
  "ARTIFACT_SOURCE_INVALID",
  "ARTIFACT_STORAGE_UNAVAILABLE",
  "ARTIFACT_RECORD_UNAVAILABLE",
  "ARTIFACT_FILE_EMPTY",
  "ARTIFACT_FILE_TOO_LARGE",
  "ARTIFACT_PREVIEW_IMAGE_INVALID",
  "ARTIFACT_PREVIEW_IMAGE_TOO_LARGE",
  "PPTX_OUTPUT_NOT_FOUND",
  "PPTX_OUTPUT_TOO_LARGE",
  "PPTX_OUTPUT_INVALID_EXTENSION",
  "PPTX_OUTPUT_INVALID_MIME",
  "PPTX_PACKAGE_INVALID",
  "SANDBOX_UNAVAILABLE",
  "PPTX_SOURCE_UNSUPPORTED",
] as const;

export const PPTX_OUTPUT_ERROR_CODES = ARTIFACT_PUBLISH_ERROR_CODES;

export type ArtifactPublishErrorCode =
  (typeof ARTIFACT_PUBLISH_ERROR_CODES)[number];

export type PptxOutputErrorCode = ArtifactPublishErrorCode;

/**
 * Infrastructure faults: the agent did nothing wrong and nothing it can change
 * about its next call will help. Telling it these are recoverable makes it
 * retry a dead dependency in a loop, burning the turn.
 *
 * Everything else is a fault in what the agent supplied — a bad path, an
 * unsupported type, an oversized or malformed file — which it can fix and
 * retry, so those stay recoverable.
 */
const UNRECOVERABLE_ARTIFACT_PUBLISH_ERROR_CODES = new Set<string>([
  "ARTIFACT_STORAGE_UNAVAILABLE",
  "ARTIFACT_RECORD_UNAVAILABLE",
  "SANDBOX_UNAVAILABLE",
]);

export function isRecoverableArtifactPublishErrorCode(
  code: ArtifactPublishErrorCode,
): boolean {
  return !UNRECOVERABLE_ARTIFACT_PUBLISH_ERROR_CODES.has(code);
}

export const PublishArtifactErrorOutputSchema = z.object({
  ok: z.literal(false),
  type: z.literal("presentation_artifact_error"),
  status: z.literal("failed"),
  code: z.enum(ARTIFACT_PUBLISH_ERROR_CODES),
  message: z.string(),
  recoverable: z.boolean(),
});

export type PublishArtifactErrorOutput = z.infer<
  typeof PublishArtifactErrorOutputSchema
>;

export type PublishArtifactOutput =
  | PublishArtifactSuccessOutput
  | PublishArtifactErrorOutput;

export class PptxOutputError extends Error {
  readonly code: ArtifactPublishErrorCode;
  readonly details?: string;

  constructor(code: ArtifactPublishErrorCode, details?: string) {
    super(details ? `${code}: ${details}` : code);
    this.name = "PptxOutputError";
    this.code = code;
    this.details = details;
  }
}

export class ArtifactPublishError extends PptxOutputError {
  constructor(code: ArtifactPublishErrorCode, details?: string) {
    super(code, details);
    this.name = "ArtifactPublishError";
  }
}
