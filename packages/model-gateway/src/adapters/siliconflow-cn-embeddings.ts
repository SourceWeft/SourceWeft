import { OpenAICompatibleEmbeddingsAdapter } from "./openai-compatible-embeddings";

export class SiliconflowCNEmbeddingsAdapter extends OpenAICompatibleEmbeddingsAdapter {
  override readonly kind = "siliconflow-cn" as const;
}
