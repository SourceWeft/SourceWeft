import { OpenAICompatibleRerankTransport } from "./openai-compatible-rerank";

export class SiliconflowCNRerankTransport extends OpenAICompatibleRerankTransport {
  override readonly kind = "siliconflow-cn" as const;
}
