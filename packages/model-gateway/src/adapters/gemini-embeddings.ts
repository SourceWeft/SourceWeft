import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import type { EmbeddingsAdapter } from "./types";
import { GatewayCaller } from "./gateway-caller";

export class GeminiEmbeddingsAdapter implements EmbeddingsAdapter {
  readonly kind = "gemini" as const;

  createModel(
    target: Parameters<EmbeddingsAdapter["createModel"]>[0],
    _input: Parameters<EmbeddingsAdapter["createModel"]>[1],
    options?: Parameters<EmbeddingsAdapter["createModel"]>[2],
  ) {
    const model = new GoogleGenerativeAIEmbeddings({
      model: target.providerModel,
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      fetch: options?.fetch,
      signal: options?.signal,
    });
    model.caller = new GatewayCaller(options);
    return model;
  }
}
