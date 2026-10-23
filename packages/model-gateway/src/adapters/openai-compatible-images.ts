import { buildProviderAuthHeaders } from "../auth-headers";
import type { ImageGenerationTransport } from "./types";
import {
  applyImageStylePrompt,
  assertGeneratedImages,
  buildImageGenerateResult,
  buildImageSizingFields,
  mapAspectRatioToOpenAIImageSize,
  mapQualityToOpenAIQuality,
  normalizeGeneratedImages,
  parseJsonResponse,
  readInferenceStatusCost,
  resolveImageGenerationRequestConfig,
  throwIfHttpError,
} from "./image-utils";

type ImageGenerationExecuteInput = Parameters<
  ImageGenerationTransport["execute"]
>[0];

/**
 * OpenAI-shaped image generation with a configuration-selected request
 * convention. A profile's `imageGeneration.request` chooses the endpoint
 * (`openai` = `/images/generations`, `native` = `/inference/{model}`) and how
 * the aspect ratio is expressed (`size`, `dimensions` or `aspect_ratio`).
 * Nothing here keys off a model name; a profile without the block sends
 * exactly what it always sent.
 */
export class OpenAICompatibleImageGenerationTransport
  implements ImageGenerationTransport
{
  readonly kind: ImageGenerationTransport["kind"] = "openai-compatible";

  protected resolveBaseUrl(target: ImageGenerationExecuteInput["target"]) {
    return target.baseUrl.replace(/\/+$/, "");
  }

  /** Provider-native inference URL; the model id is part of the path. */
  protected resolveNativeUrl(target: ImageGenerationExecuteInput["target"]) {
    return `${target.baseUrl.replace(/\/+$/, "")}/inference/${target.providerModel}`;
  }

  protected buildProviderBody(
    input: ImageGenerationExecuteInput,
  ): Record<string, unknown> {
    const { sizing } = resolveImageGenerationRequestConfig(input.target);
    return {
      model: input.target.providerModel,
      prompt: applyImageStylePrompt(input.payload),
      n: input.payload.count ?? 1,
      response_format: input.payload.responseFormat ?? "b64_json",
      ...buildImageSizingFields(sizing, input.payload.aspectRatio),
      quality: mapQualityToOpenAIQuality(input.payload.quality),
      ...(input.payload.extraBody ?? {}),
    };
  }

  protected buildNativeBody(
    input: ImageGenerationExecuteInput,
  ): Record<string, unknown> {
    const { sizing } = resolveImageGenerationRequestConfig(input.target);
    return {
      prompt: applyImageStylePrompt(input.payload),
      ...buildImageSizingFields(sizing, input.payload.aspectRatio),
      ...(input.payload.extraBody ?? {}),
    };
  }

  /**
   * The `WxH` recorded for per-image pricing: what the request actually
   * asked for when it carried pixels, else the table value for the ratio.
   */
  protected resolveRequestedImageSize(input: ImageGenerationExecuteInput) {
    const { sizing } = resolveImageGenerationRequestConfig(input.target);
    const fields = buildImageSizingFields(sizing, input.payload.aspectRatio);
    if (typeof fields.size === "string") {
      return fields.size;
    }
    if (typeof fields.width === "number" && typeof fields.height === "number") {
      return `${fields.width}x${fields.height}`;
    }
    return mapAspectRatioToOpenAIImageSize(input.payload.aspectRatio);
  }

  async execute(input: ImageGenerationExecuteInput) {
    const { endpoint } = resolveImageGenerationRequestConfig(input.target);
    const native = endpoint === "native";
    const response = await input.fetch(
      native
        ? this.resolveNativeUrl(input.target)
        : `${this.resolveBaseUrl(input.target)}/images/generations`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...input.target.defaultHeaders,
          ...buildProviderAuthHeaders(input.target),
        },
        body: JSON.stringify(
          native ? this.buildNativeBody(input) : this.buildProviderBody(input),
        ),
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
      imageSize: this.resolveRequestedImageSize(input),
      imageQuality: mapQualityToOpenAIQuality(input.payload.quality),
      providerCost: readInferenceStatusCost(raw, input.target.provider),
      traceId: input.options?.traceId,
    });
  }
}
