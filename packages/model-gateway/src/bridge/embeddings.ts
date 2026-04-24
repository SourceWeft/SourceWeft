import { normalizeGatewayError } from "../errors";
import { createEmbeddingsModel } from "./utils";
import type {
  EmbedBatchInput,
  EmbedBatchResult,
  EmbedInput,
  EmbedResult,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
  RequestOptions,
} from "../types";

export async function runBridgeEmbedding(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: EmbedInput;
  options?: RequestOptions;
}): Promise<EmbedResult> {
  try {
    const model = createEmbeddingsModel(input);
    const embedding = await model.embedQuery(input.payload.text);
    return {
      model: input.target.providerModel,
      embedding,
      provider: input.target.provider,
      providerModel: input.target.providerModel,
      routeDecision: input.target.routeDecision,
      traceId: input.options?.traceId,
      raw: {
        provider: input.target.provider,
        providerModel: input.target.providerModel,
        embedding,
      },
    };
  } catch (error) {
    throw normalizeGatewayError(error);
  }
}

export async function runBridgeEmbeddingBatch(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: EmbedBatchInput;
  options?: RequestOptions;
}): Promise<EmbedBatchResult> {
  try {
    const model = createEmbeddingsModel(input);
    const embeddings = await model.embedDocuments(input.payload.texts);
    return {
      model: input.target.providerModel,
      embeddings,
      provider: input.target.provider,
      providerModel: input.target.providerModel,
      routeDecision: input.target.routeDecision,
      traceId: input.options?.traceId,
      raw: {
        provider: input.target.provider,
        providerModel: input.target.providerModel,
        embeddings,
      },
    };
  } catch (error) {
    throw normalizeGatewayError(error);
  }
}
