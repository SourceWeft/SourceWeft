import { OpenAIEmbeddings } from "@langchain/openai";
import type { EmbeddingsAdapter } from "./types";

export class OpenAICompatibleEmbeddingsAdapter implements EmbeddingsAdapter {
  readonly kind = "openai-compatible" as const;

  createModel(target: Parameters<EmbeddingsAdapter["createModel"]>[0], input: Parameters<EmbeddingsAdapter["createModel"]>[1]) {
    return new OpenAIEmbeddings({
      model: target.providerModel,
      apiKey: target.apiKey,
      dimensions: input.dimensions,
      encodingFormat: input.encodingFormat,
      configuration: {
        baseURL: target.baseUrl,
        defaultHeaders: target.defaultHeaders,
      },
    });
  }
}
