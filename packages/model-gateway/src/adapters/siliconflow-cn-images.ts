import {
  applyImageStylePrompt,
  mapAspectRatioToOpenAIImageSize,
  mapQualityToResolutionName,
} from "./image-utils";
import { OpenAICompatibleImageGenerationTransport } from "./openai-compatible-images";
import type { ImageGenerationTransport } from "./types";

export class SiliconflowCNImageGenerationTransport extends OpenAICompatibleImageGenerationTransport {
  override readonly kind = "siliconflow-cn" as const;

  override buildProviderBody(
    input: Parameters<ImageGenerationTransport["execute"]>[0],
  ): Record<string, unknown> {
    return {
      model: input.target.providerModel,
      prompt: applyImageStylePrompt(input.payload),
      image_size:
        mapQualityToResolutionName(input.payload.quality) ??
        mapAspectRatioToOpenAIImageSize(input.payload.aspectRatio),
      batch_size: input.payload.count ?? 1,
      ...(input.payload.extraBody ?? {}),
    };
  }
}
