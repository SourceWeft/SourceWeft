import type { AsrLimits } from "../asr/types";
import { OpenAICompatibleAsrTransport } from "./openai-compatible-asr";
import type { AsrTransport } from "./types";

export class DeepInfraAsrTransport extends OpenAICompatibleAsrTransport {
  readonly kind = "deepinfra" as const;

  // DeepInfra documents no caps. 25 MB and 30 minutes are assumptions that
  // keep requests in a range its Whisper endpoints are known to handle.
  override limits(): AsrLimits {
    return {
      acceptedFormats: this.supportedAudioFormats,
      maxBytes: 25_000_000,
      maxDurationSec: 1_800,
      timestamps: "segment",
      chunkSec: 600,
      maxConcurrent: 4,
    };
  }

  protected override resolveBaseUrl(
    target: Parameters<AsrTransport["execute"]>[0]["target"],
  ) {
    return `${target.baseUrl.replace(/\/+$/, "")}/openai`;
  }
}
