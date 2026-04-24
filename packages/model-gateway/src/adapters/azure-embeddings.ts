import { AzureOpenAIEmbeddings } from "@langchain/openai";
import type { EmbeddingsAdapter } from "./types";

export class AzureEmbeddingsAdapter implements EmbeddingsAdapter {
  readonly kind = "azure-openai" as const;

  createModel(target: Parameters<EmbeddingsAdapter["createModel"]>[0], input: Parameters<EmbeddingsAdapter["createModel"]>[1]) {
    return new AzureOpenAIEmbeddings({
      model: target.providerModel,
      azureOpenAIApiKey: target.apiKey,
      azureOpenAIEndpoint: target.baseUrl,
      deploymentName: target.providerModel,
      dimensions: input.dimensions,
    });
  }
}
