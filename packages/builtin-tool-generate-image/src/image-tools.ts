import { z } from "zod";

export type ArtifactImageConfigLike = {
  readonly aspectRatio: string;
  readonly quality: string;
  readonly style: string;
};

export const generateImageSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  title: z.string().trim().min(1).max(160).optional(),
});

export function sanitizeImageArtifactFileBase(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "generated-image";
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
