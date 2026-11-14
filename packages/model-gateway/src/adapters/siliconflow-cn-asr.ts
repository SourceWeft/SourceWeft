import type { AsrLimits } from "../asr/types";
import { OpenAICompatibleAsrTransport } from "./openai-compatible-asr";

export class SiliconflowCNAsrTransport extends OpenAICompatibleAsrTransport {
  override readonly kind = "siliconflow-cn" as const;

  // SiliconFlow's API reference states no caps and returns only `text`.
  // 50 MB and one hour are the figures reported for its models, so a file
  // within them goes up whole, exactly as before. Only longer audio is split,
  // into 20 minute chunks (38 MB of 16 kHz PCM, under the size figure).
  override limits(): AsrLimits {
    return {
      acceptedFormats: this.supportedAudioFormats,
      maxBytes: 50_000_000,
      maxDurationSec: 3_600,
      timestamps: "none",
      chunkSec: 1_200,
      maxConcurrent: 2,
    };
  }
}
