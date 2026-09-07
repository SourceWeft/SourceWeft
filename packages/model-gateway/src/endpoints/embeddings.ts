import { resolveRequestOptions } from "../request-options";
import { normalizeGatewayError } from "../errors";
import type { ModelCallObservation } from "../observation/types";
import {
  runBridgeEmbedding,
  runBridgeEmbeddingBatch,
} from "../bridge/embeddings";
import { runWithTargetFailover } from "./failover";
import {
  buildGenerationErrorEvent,
  createGenerationObservation,
  emitGenerationEnd,
  emitGenerationError,
  emitGenerationStart,
  toProviderResponse,
} from "../observe/generation";
import type {
  EmbedBatchInput,
  EmbedBatchResult,
  EmbedInput,
  EmbedResult,
  RequestOptions,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
} from "../types";

export class ModelGatewayEmbeddingsEndpoint {
  constructor(private readonly config: ResolvedModelGatewayConfig) {}

  async embed(
    input: EmbedInput,
    options?: RequestOptions,
  ): Promise<EmbedResult> {
    return runWithTargetFailover({
      config: this.config,
      payload: input,
      operation: "embeddings.embed",
      callerSignal: options?.signal,
      attempt: (target) =>
        this.embedWithTarget(
          input,
          resolveRequestOptions(this.config, target, options),
          target,
        ),
    });
  }

  private async embedWithTarget(
    input: EmbedInput,
    options: RequestOptions | undefined,
    target: ResolvedRequestTarget,
  ): Promise<EmbedResult> {
    const generation = createGenerationObservation({
      operation: "embeddings.embed",
      payload: input,
      options,
      target,
    });
    await emitGenerationStart(this.config, generation.start);
    let finalObservation: ModelCallObservation | undefined;
    const onFinalObservation = (observation: ModelCallObservation) => {
      observation.traceId = generation.start.traceId;
      observation.spanId = generation.spanId;
      finalObservation = observation;
    };
    try {
      const result = await runBridgeEmbedding({
        config: this.config,
        target,
        payload: input,
        options,
        onFinalObservation,
      });
      await emitGenerationEnd(this.config, {
        traceId: generation.start.traceId,
        spanId: generation.spanId,
        endedAt: new Date().toISOString(),
        latencyMs: Date.now() - generation.startedAtMs,
        output: {
          model: result.model,
          embeddingCount: 1,
          dimensions: result.embedding.length,
          provider: result.provider,
          providerModel: result.providerModel,
          routeDecision: result.routeDecision,
        },
        usage: result.usage,
        observation: result.observation,
        rawCaptureMode: "sdk_metadata",
        providerResponse: toProviderResponse(result.raw),
        attributes: generation.start.attributes,
      });
      return result;
    } catch (error) {
      await emitGenerationError(this.config, {
        ...buildGenerationErrorEvent({
          traceId: generation.start.traceId,
          spanId: generation.spanId,
          startedAtMs: generation.startedAtMs,
          error,
          attributes: generation.start.attributes,
        }),
        usage: finalObservation?.usage,
        observation: finalObservation,
      });
      throw normalizeGatewayError(error);
    }
  }

  async embedBatch(
    input: EmbedBatchInput,
    options?: RequestOptions,
  ): Promise<EmbedBatchResult> {
    return runWithTargetFailover({
      config: this.config,
      payload: input,
      operation: "embeddings.embedBatch",
      callerSignal: options?.signal,
      attempt: (target) =>
        this.embedBatchWithTarget(
          input,
          resolveRequestOptions(this.config, target, options),
          target,
        ),
    });
  }

  private async embedBatchWithTarget(
    input: EmbedBatchInput,
    options: RequestOptions | undefined,
    target: ResolvedRequestTarget,
  ): Promise<EmbedBatchResult> {
    const generation = createGenerationObservation({
      operation: "embeddings.embedBatch",
      payload: input,
      options,
      target,
    });
    await emitGenerationStart(this.config, generation.start);
    let finalObservation: ModelCallObservation | undefined;
    const onFinalObservation = (observation: ModelCallObservation) => {
      observation.traceId = generation.start.traceId;
      observation.spanId = generation.spanId;
      finalObservation = observation;
    };
    try {
      const result = await runBridgeEmbeddingBatch({
        config: this.config,
        target,
        payload: input,
        options,
        onFinalObservation,
      });
      await emitGenerationEnd(this.config, {
        traceId: generation.start.traceId,
        spanId: generation.spanId,
        endedAt: new Date().toISOString(),
        latencyMs: Date.now() - generation.startedAtMs,
        output: {
          model: result.model,
          embeddingCount: result.embeddings.length,
          dimensions: result.embeddings[0]?.length ?? null,
          provider: result.provider,
          providerModel: result.providerModel,
          routeDecision: result.routeDecision,
        },
        usage: result.usage,
        observation: result.observation,
        rawCaptureMode: "sdk_metadata",
        providerResponse: toProviderResponse(result.raw),
        attributes: generation.start.attributes,
      });
      return result;
    } catch (error) {
      await emitGenerationError(this.config, {
        ...buildGenerationErrorEvent({
          traceId: generation.start.traceId,
          spanId: generation.spanId,
          startedAtMs: generation.startedAtMs,
          error,
          attributes: generation.start.attributes,
        }),
        usage: finalObservation?.usage,
        observation: finalObservation,
      });
      throw normalizeGatewayError(error);
    }
  }
}
