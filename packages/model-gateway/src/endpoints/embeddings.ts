import { resolveRequestTarget } from "../config";
import { normalizeGatewayError } from "../errors";
import { runBridgeEmbedding, runBridgeEmbeddingBatch } from "../bridge/embeddings";
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
} from "../types";

export class ModelGatewayEmbeddingsEndpoint {
  constructor(private readonly config: ResolvedModelGatewayConfig) {}

  async embed(
    input: EmbedInput,
    options?: RequestOptions,
  ): Promise<EmbedResult> {
    const target = await resolveRequestTarget(this.config, input);
    const generation = createGenerationObservation({
      operation: "embeddings.embed",
      payload: input,
      options,
      target,
    });
    await emitGenerationStart(this.config, generation.start);
    try {
      const result = await runBridgeEmbedding({
        config: this.config,
        target,
        payload: input,
        options,
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
        rawCaptureMode: "sdk_metadata",
        providerResponse: toProviderResponse(result.raw),
        attributes: generation.start.attributes,
      });
      return result;
    } catch (error) {
      await emitGenerationError(
        this.config,
        buildGenerationErrorEvent({
          traceId: generation.start.traceId,
          spanId: generation.spanId,
          startedAtMs: generation.startedAtMs,
          error,
          attributes: generation.start.attributes,
        }),
      );
      throw normalizeGatewayError(error);
    }
  }

  async embedBatch(
    input: EmbedBatchInput,
    options?: RequestOptions,
  ): Promise<EmbedBatchResult> {
    const target = await resolveRequestTarget(this.config, input);
    const generation = createGenerationObservation({
      operation: "embeddings.embedBatch",
      payload: input,
      options,
      target,
    });
    await emitGenerationStart(this.config, generation.start);
    try {
      const result = await runBridgeEmbeddingBatch({
        config: this.config,
        target,
        payload: input,
        options,
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
        rawCaptureMode: "sdk_metadata",
        providerResponse: toProviderResponse(result.raw),
        attributes: generation.start.attributes,
      });
      return result;
    } catch (error) {
      await emitGenerationError(
        this.config,
        buildGenerationErrorEvent({
          traceId: generation.start.traceId,
          spanId: generation.spanId,
          startedAtMs: generation.startedAtMs,
          error,
          attributes: generation.start.attributes,
        }),
      );
      throw normalizeGatewayError(error);
    }
  }
}
