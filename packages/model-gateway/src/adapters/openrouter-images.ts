import { buildProviderAuthHeaders } from "../auth-headers";
import type { ImageGenerationTransport } from "./types";
import {
  applyImageStylePrompt,
  assertGeneratedImages,
  buildImageGenerateResult,
  normalizeGeneratedImages,
  parseJsonResponse,
  throwIfHttpError,
} from "./image-utils";
import type { ImageQuality } from "../types";

function isGemini31FlashImagePreview(modelId: string | undefined) {
  return modelId?.trim().toLowerCase() === "google/gemini-3.1-flash-image-preview";
}

function isGeminiImageModel(modelId: string | undefined) {
  return modelId?.trim().toLowerCase().startsWith("google/gemini-") === true;
}

function resolveOpenRouterModalities(modelId: string | undefined) {
  return isGeminiImageModel(modelId) ? ["image", "text"] : ["image"];
}

function mapQualityToOpenRouterImageSize(
  quality: ImageQuality | undefined,
  input: { supportsLowResolution: boolean },
) {
  switch (quality) {
    case "low":
      return input.supportsLowResolution ? "0.5K" : undefined;
    case "standard":
      return "1K";
    case "higher":
      return "2K";
    case "highest":
      return "4K";
    default:
      return undefined;
  }
}

function buildOpenRouterImageConfig(
  input: Parameters<ImageGenerationTransport["execute"]>[0],
) {
  const { payload, target } = input;
  const imageConfig: Record<string, unknown> = {};
  if (payload.aspectRatio && payload.aspectRatio !== "auto") {
    imageConfig.aspect_ratio = payload.aspectRatio;
  }
  if (isGeminiImageModel(target.providerModel)) {
    const imageSize = mapQualityToOpenRouterImageSize(payload.quality, {
      supportsLowResolution: isGemini31FlashImagePreview(target.providerModel),
    });
    if (imageSize) {
      imageConfig.image_size = imageSize;
    }
  }
  return Object.keys(imageConfig).length > 0 ? imageConfig : undefined;
}

export class OpenRouterImageGenerationTransport
  implements ImageGenerationTransport
{
  readonly kind = "openrouter" as const;

  async execute(input: Parameters<ImageGenerationTransport["execute"]>[0]) {
    const imageConfig = buildOpenRouterImageConfig(input);
    const response = await input.fetch(
      `${input.target.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...input.target.defaultHeaders,
          ...buildProviderAuthHeaders(input.target),
        },
        body: JSON.stringify({
          model: input.target.providerModel,
          messages: [
            {
              role: "user",
              content: applyImageStylePrompt(input.payload),
            },
          ],
          modalities: resolveOpenRouterModalities(input.target.providerModel),
          ...(imageConfig ? { image_config: imageConfig } : {}),
          ...(input.payload.extraBody ?? {}),
        }),
        signal: input.options?.signal,
      },
    );

    const raw = await parseJsonResponse(response);
    throwIfHttpError(response, raw);

    const images = normalizeGeneratedImages(raw);
    assertGeneratedImages(images);

    return buildImageGenerateResult({
      raw,
      target: input.target,
      images,
      traceId: input.options?.traceId,
    });
  }
}
