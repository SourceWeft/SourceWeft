import { OpenAICompatibleAsrTransport } from "./openai-compatible-asr";

export class SiliconflowCNAsrTransport extends OpenAICompatibleAsrTransport {
  override readonly kind = "siliconflow-cn" as const;
}
