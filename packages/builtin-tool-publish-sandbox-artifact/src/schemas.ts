import { z } from "zod";

export const SandboxPathSourceSchema = z.object({
  kind: z.literal("sandbox_path"),
  path: z
    .string()
    .min(1)
    .describe(
      "Absolute path inside the sandbox, for example /workspace/Presentation.pptx.",
    ),
});

export const WorkFileSourceSchema = z.object({
  kind: z.literal("work_file"),
  path: z
    .string()
    .min(1)
    .describe("SourceWeft /workfiles path for an already-collected PPTX file."),
});

export const QaSummarySchema = z.object({
  contentChecked: z.boolean().default(false),
  visualChecked: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
});

const PublishSlidesArtifactInputSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe("Presentation title for artifact metadata."),
  description: z.string().optional(),
  source: z.discriminatedUnion("kind", [
    SandboxPathSourceSchema,
    WorkFileSourceSchema,
  ]),
  qa: QaSummarySchema.optional(),
});

export const PublishSandboxArtifactInputSchema =
  PublishSlidesArtifactInputSchema.extend({
    artifactType: z
      .literal("slides")
      .describe(
        "Artifact type to publish. Slides currently require a PPTX source.",
      ),
  });

export type PublishSandboxArtifactInput = z.infer<
  typeof PublishSandboxArtifactInputSchema
>;

export const PublishSandboxArtifactOutputSchema = z.object({
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
  qaWarnings: z.array(z.string()),
});

export type PublishSandboxArtifactSuccessOutput = z.infer<
  typeof PublishSandboxArtifactOutputSchema
>;

export const PPTX_OUTPUT_ERROR_CODES = [
  "PPTX_OUTPUT_NOT_FOUND",
  "PPTX_OUTPUT_TOO_LARGE",
  "PPTX_OUTPUT_INVALID_EXTENSION",
  "PPTX_PACKAGE_INVALID",
  "SANDBOX_UNAVAILABLE",
  "PPTX_SOURCE_UNSUPPORTED",
] as const;

export type PptxOutputErrorCode = (typeof PPTX_OUTPUT_ERROR_CODES)[number];

export const PublishSandboxArtifactErrorOutputSchema = z.object({
  ok: z.literal(false),
  type: z.literal("presentation_artifact_error"),
  status: z.literal("failed"),
  code: z.enum(PPTX_OUTPUT_ERROR_CODES),
  message: z.string(),
  recoverable: z.literal(true),
});

export type PublishSandboxArtifactErrorOutput = z.infer<
  typeof PublishSandboxArtifactErrorOutputSchema
>;

export type PublishSandboxArtifactOutput =
  | PublishSandboxArtifactSuccessOutput
  | PublishSandboxArtifactErrorOutput;

export class PptxOutputError extends Error {
  readonly code: PptxOutputErrorCode;
  readonly details?: string;

  constructor(code: PptxOutputErrorCode, details?: string) {
    super(details ? `${code}: ${details}` : code);
    this.name = "PptxOutputError";
    this.code = code;
    this.details = details;
  }
}
