import { OpenAICompatibleImageGenerationTransport } from "./openai-compatible-images";
import type { ImageGenerationTransport } from "./types";

export class DeepInfraImagesGenerationTransport extends OpenAICompatibleImageGenerationTransport {
  override readonly kind = "deepinfra" as const;

  override resolveBaseUrl(
    target: Parameters<ImageGenerationTransport["execute"]>[0]["target"],
  ) {
    return `${target.baseUrl.replace(/\/+$/, "")}/openai`;
  }
}
