import {
  extensionForMimeType,
  sanitizeArtifactFileBase,
} from "@sourceweft/contracts/artifact-files";
import { z } from "zod";

const IMAGE_FILE_BASE_FALLBACK = "generated-image";

export type ArtifactImageConfigLike = {
  readonly aspectRatio: string;
  readonly quality: string;
  readonly style: string;
};

export const generateImageSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  title: z.string().trim().min(1).max(160).optional(),
});

/**
 * Where a generated image artifact came from, as persisted under
 * `payload_json.source`.
 *
 * This `source` is NOT `ArtifactSourceSchema` from
 * `@sourceweft/builtin-tool-publish-artifact` — the two only collide on a field
 * name. That one is a discriminated union of *byte locations*
 * (`sandbox_path` | `work_file`), every variant of which carries a `path` and is
 * handed to `adapterForSource` to be read from. This one is *provenance*: which
 * tool produced the bytes that are already in hand. A generated image has no
 * path to read from, so it belongs in neither the union nor its adapters —
 * adding `generated_image` there would only produce
 * "source.kind is not supported" at the first read attempt.
 *
 * It used to be an unvalidated object literal that reached
 * `publishPreparedArtifact`, which skips the zod parse `publishArtifact` runs,
 * so a value no schema recognized was persisted for as long as nobody looked.
 */
export const GeneratedImageProvenanceSchema = z.object({
  kind: z.literal("generated_image"),
  tool: z.string().min(1),
});

export type GeneratedImageProvenance = z.infer<
  typeof GeneratedImageProvenanceSchema
>;

export function generatedImageProvenance(
  toolName: string,
): GeneratedImageProvenance {
  return GeneratedImageProvenanceSchema.parse({
    kind: "generated_image",
    tool: toolName,
  });
}

/**
 * Image download names used to be lowercased and stripped of every non-ASCII
 * character, so a title like "Résumé Q3" landed as `r-sum-q3` while the same
 * title published through another capability kept its letters. It now shares
 * the artifact-wide naming rule.
 */
export function sanitizeImageArtifactFileBase(value: string): string {
  return sanitizeArtifactFileBase(value, {
    fallback: IMAGE_FILE_BASE_FALLBACK,
  });
}

/**
 * Providers are free to return JPEG or WebP; naming every download `.png`
 * produced files whose extension contradicted their bytes, which then drove the
 * wrong Content-Type on re-upload and download.
 *
 * Unknown image types fall back to `.png` only because that is what callers
 * already assumed — the mismatch is at least no worse than before.
 */
export function imageFileExtensionForMimeType(
  mimeType: string | undefined | null,
): string {
  return extensionForMimeType(mimeType, ".png");
}

export function buildImageRuntimePromptLines(input: {
  readonly config: ArtifactImageConfigLike;
  readonly toolName: string;
}): string[] {
  const { config, toolName } = input;
  return [
    `Image generation defaults: aspect_ratio=${config.aspectRatio}, quality=${config.quality}, style=${config.style}.`,
    `${toolName} is available in auto mode. Use it when the user asks you to create a new visual artifact or deliverable; otherwise answer normally.`,
    `For ambiguous requests, decide semantically from the user's goal rather than matching literal keywords. If the user expects a kept visual output, call ${toolName}.`,
    "If the prompt is missing essential visual details for a requested image, make a reasonable concise prompt instead of asking a separate confirmation.",
    `Never claim an image was created unless ${toolName} completed successfully.`,
    `After ${toolName} succeeds, decide whether a short natural-language wrap-up is useful. The application displays the generated image automatically; do not include image markdown or raw artifact URLs.`,
  ];
}

export function buildImageToolResult(input: {
  readonly artifactId: string;
  readonly artifactUrl?: string;
  readonly config: ArtifactImageConfigLike;
  readonly height?: number;
  readonly provider?: string;
  readonly providerModel?: string;
  readonly title: string;
  readonly versionId: string;
  readonly width?: number;
}): string {
  return [
    "Image artifact created.",
    `artifact_id: ${input.artifactId}`,
    `version_id: ${input.versionId}`,
    `title: ${input.title}`,
    input.artifactUrl ? `artifact_url: ${input.artifactUrl}` : null,
    `aspect_ratio: ${input.config.aspectRatio}`,
    typeof input.width === "number" ? `width: ${input.width}` : null,
    typeof input.height === "number" ? `height: ${input.height}` : null,
    `quality: ${input.config.quality}`,
    `style: ${input.config.style}`,
    input.provider ? `provider: ${input.provider}` : null,
    input.providerModel ? `provider_model: ${input.providerModel}` : null,
    "The application will display the generated image automatically. Do not include image markdown or repeat raw URLs.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
