import { sdkRetryOptions } from "./gateway-caller";
import { ObservedAzureOpenAIEmbeddings } from "./observed-embeddings";
import type { EmbeddingsAdapter } from "./types";

export class AzureEmbeddingsAdapter implements EmbeddingsAdapter {
  readonly kind = "azure-openai" as const;

  createModel(
    target: Parameters<EmbeddingsAdapter["createModel"]>[0],
    input: Parameters<EmbeddingsAdapter["createModel"]>[1],
    options?: Parameters<EmbeddingsAdapter["createModel"]>[2],
  ) {
    return new ObservedAzureOpenAIEmbeddings({
      model: target.providerModel,
      ...sdkRetryOptions(options),
      timeout: options?.timeoutMs,
      azureOpenAIApiKey: target.apiKey,
      // This SDK's embedding adapter reads BasePath / ApiDeploymentName,
      // unlike its chat adapter's Endpoint / deploymentName fields.
      azureOpenAIBasePath: `${target.baseUrl.replace(/\/+$/, "")}/openai/deployments`,
      configuration: {
        fetch: options?.fetch,
        adminAPIKey: null,
        ignoreEnvironmentHeaders: true,
      },
      azureOpenAIApiDeploymentName: target.providerModel,
      dimensions: input.dimensions,
    });
  }
}
