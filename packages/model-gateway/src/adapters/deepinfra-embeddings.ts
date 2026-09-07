import { sdkRetryOptions } from "./gateway-caller";
import { ObservedOpenAIEmbeddings } from "./observed-embeddings";
import { ModelGatewayError } from "../errors";
import type { EmbeddingsAdapter } from "./types";

function resolveOpenAICompatibleBaseUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, "")}/openai`;
}

export class DeepInfraEmbeddingsAdapter implements EmbeddingsAdapter {
  readonly kind = "deepinfra" as const;

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
      encodingFormat: resolveDeepInfraEncodingFormat(input.encodingFormat),
      configuration: {
        ignoreEnvironmentHeaders: true,
        fetch: options?.fetch,
        adminAPIKey: null,
        baseURL: resolveOpenAICompatibleBaseUrl(target.baseUrl),
        defaultHeaders: target.defaultHeaders,
      },
    });
  }
}

function resolveDeepInfraEncodingFormat(
  encodingFormat: Parameters<
    EmbeddingsAdapter["createModel"]
  >[1]["encodingFormat"],
) {
  if (encodingFormat === "base64") {
    throw new ModelGatewayError({
      code: "BAD_REQUEST",
      message:
        "DeepInfra OpenAI-compatible embeddings only support encodingFormat 'float' in this gateway",
      retryable: false,
      provider: "deepinfra",
    });
  }

  return encodingFormat ?? "float";
}
