import { OpenAIEmbeddings } from "@langchain/openai";
import { ModelGatewayError } from "../errors";
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
      encodingFormat: resolveDeepInfraEncodingFormat(input.encodingFormat),
      configuration: {
        baseURL: openAICompatibleBaseUrl,
        defaultHeaders: target.defaultHeaders,
      },
    });
  }
}

function resolveDeepInfraEncodingFormat(
  encodingFormat: Parameters<EmbeddingsAdapter["createModel"]>[1]["encodingFormat"],
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
