import { OpenAIEmbeddings } from "@langchain/openai";
import { resolveDeepInfraBaseUrls } from "./deepinfra-url";
import type { EmbeddingsAdapter } from "./types";

export class DeepInfraEmbeddingsAdapter implements EmbeddingsAdapter {
  readonly kind = "deepinfra" as const;

  createModel(target: Parameters<EmbeddingsAdapter["createModel"]>[0], input: Parameters<EmbeddingsAdapter["createModel"]>[1]) {
    const { openAICompatibleBaseUrl } = resolveDeepInfraBaseUrls(target.baseUrl);

    return new OpenAIEmbeddings({
      model: target.providerModel,
      apiKey: target.apiKey,
      dimensions: input.dimensions,
      encodingFormat: input.encodingFormat,
      configuration: {
        baseURL: openAICompatibleBaseUrl,
        defaultHeaders: target.defaultHeaders,
      },
    });
  }
}
