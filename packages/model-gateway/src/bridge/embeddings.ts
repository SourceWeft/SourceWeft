import { awaitWithSignal } from "../request-options";
import { normalizeGatewayError } from "../errors";
import {
  createEmbeddingResponseCapture,
  finishEmbeddingResponseCapture,
  runWithEmbeddingResponseCapture,
} from "../observation/embedding-capture";
import type { ModelCallObservation } from "../observation/types";
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
  onFinalObservation?: (observation: ModelCallObservation) => void;
}): Promise<EmbedResult> {
  const capture = createEmbeddingResponseCapture();
  let failed = false;
  let embedding: number[];
  let observation: ModelCallObservation;
  try {
    const model = createEmbeddingsModel(input);
    embedding = await runWithEmbeddingResponseCapture(capture, () =>
      awaitWithSignal(input.options?.signal, () =>
        model.embedQuery(input.payload.text),
      ),
    );
  } catch (error) {
    failed = true;
    throw normalizeGatewayError(error);
  } finally {
    observation = finishEmbeddingResponseCapture({
      capture,
      target: input.target,
      modelAlias: input.payload.model,
      failed,
    });
    input.onFinalObservation?.(observation);
  }
  return {
    observation,
    usage: observation.usage,
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
}

export async function runBridgeEmbeddingBatch(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: EmbedBatchInput;
  options?: RequestOptions;
  onFinalObservation?: (observation: ModelCallObservation) => void;
}): Promise<EmbedBatchResult> {
  const capture = createEmbeddingResponseCapture();
  let failed = false;
  let embeddings: number[][];
  let observation: ModelCallObservation;
  try {
    const model = createEmbeddingsModel(input);
    embeddings = await runWithEmbeddingResponseCapture(capture, () =>
      awaitWithSignal(input.options?.signal, () =>
        model.embedDocuments(input.payload.texts),
      ),
    );
  } catch (error) {
    failed = true;
    throw normalizeGatewayError(error);
  } finally {
    observation = finishEmbeddingResponseCapture({
      capture,
      target: input.target,
      modelAlias: input.payload.model,
      failed,
    });
    input.onFinalObservation?.(observation);
  }
  return {
    observation,
    usage: observation.usage,
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
}
