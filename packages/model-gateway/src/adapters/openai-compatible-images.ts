import { buildProviderAuthHeaders } from "../auth-headers";
import type { ImageGenerationTransport } from "./types";
import {
  applyImageStylePrompt,
  assertGeneratedImages,
  buildImageGenerateResult,
  mapAspectRatioToOpenAIImageSize,
  mapQualityToOpenAIQuality,
  normalizeGeneratedImages,
  parseJsonResponse,
  throwIfHttpError,
} from "./image-utils";

export class OpenAICompatibleImageGenerationTransport
  implements ImageGenerationTransport
{
  readonly kind: ImageGenerationTransport["kind"] = "openai-compatible";

  protected resolveBaseUrl(
    target: Parameters<ImageGenerationTransport["execute"]>[0]["target"],
  ) {
    return target.baseUrl.replace(/\/+$/, "");
  }

  protected buildProviderBody(
    input: Parameters<ImageGenerationTransport["execute"]>[0],
  ): Record<string, unknown> {
    return {
      model: input.target.providerModel,
      prompt: applyImageStylePrompt(input.payload),
      n: input.payload.count ?? 1,
      response_format: input.payload.responseFormat ?? "b64_json",
      size: mapAspectRatioToOpenAIImageSize(input.payload.aspectRatio),
      quality: mapQualityToOpenAIQuality(input.payload.quality),
      ...(input.payload.extraBody ?? {}),
    };
  }

  async execute(input: Parameters<ImageGenerationTransport["execute"]>[0]) {
    const response = await input.fetch(
      `${this.resolveBaseUrl(input.target)}/images/generations`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...input.target.defaultHeaders,
          ...buildProviderAuthHeaders(input.target),
        },
        body: JSON.stringify(this.buildProviderBody(input)),
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
      imageSize: mapAspectRatioToOpenAIImageSize(input.payload.aspectRatio),
      imageQuality: mapQualityToOpenAIQuality(input.payload.quality),
      traceId: input.options?.traceId,
    });
  }
}
