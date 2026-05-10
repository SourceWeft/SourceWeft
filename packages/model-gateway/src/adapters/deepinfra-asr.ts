import { OpenAICompatibleAsrTransport } from "./openai-compatible-asr";
import type { AsrTransport } from "./types";

export class DeepInfraAsrTransport extends OpenAICompatibleAsrTransport {
  readonly kind = "deepinfra" as const;

  protected override resolveBaseUrl(
    target: Parameters<AsrTransport["execute"]>[0]["target"],
  ) {
    return `${target.baseUrl.replace(/\/+$/, "")}/openai`;
  }
}
