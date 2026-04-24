import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import type { EmbeddingsAdapter } from "./types";

export class GeminiEmbeddingsAdapter implements EmbeddingsAdapter {
  readonly kind = "gemini" as const;

  createModel(target: Parameters<EmbeddingsAdapter["createModel"]>[0]) {
    return new GoogleGenerativeAIEmbeddings({
      model: target.providerModel,
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
    });
  }
}
