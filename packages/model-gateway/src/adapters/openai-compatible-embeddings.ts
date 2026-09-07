import { sdkRetryOptions } from "./gateway-caller";
import { ObservedOpenAIEmbeddings } from "./observed-embeddings";
import {
  buildOpenAICompatibleDefaultHeaders,
  unauthenticatedOpenAIConfiguration,
} from "../auth-headers";
import type { EmbeddingsAdapter } from "./types";

export class OpenAICompatibleEmbeddingsAdapter implements EmbeddingsAdapter {
  readonly kind: EmbeddingsAdapter["kind"] = "openai-compatible";

  createModel(
    target: Parameters<EmbeddingsAdapter["createModel"]>[0],
    input: Parameters<EmbeddingsAdapter["createModel"]>[1],
    options?: Parameters<EmbeddingsAdapter["createModel"]>[2],
  ) {
    return new ObservedOpenAIEmbeddings({
      model: target.providerModel,
      ...sdkRetryOptions(options),
      timeout: options?.timeoutMs,
      apiKey: target.apiKey,
      dimensions: input.dimensions,
      encodingFormat: input.encodingFormat,
      configuration: {
        ignoreEnvironmentHeaders: true,
        fetch: options?.fetch,
        adminAPIKey: null,
        baseURL: target.baseUrl,
        defaultHeaders: buildOpenAICompatibleDefaultHeaders(target),
        ...unauthenticatedOpenAIConfiguration(target),
      },
    });
  }
}
