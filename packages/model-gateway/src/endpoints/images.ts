import { normalizeGatewayError } from "../errors";
import { runBridgeImageGeneration } from "../bridge/images";
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
  ImageGenerateInput,
  ImageGenerateResult,
  RequestOptions,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
} from "../types";

export class ModelGatewayImagesEndpoint {
  constructor(private readonly config: ResolvedModelGatewayConfig) {}

  async generate(
    input: ImageGenerateInput,
    options?: RequestOptions,
  ): Promise<ImageGenerateResult> {
    return runWithTargetFailover({
      config: this.config,
      payload: input,
      operation: "images.generate",
      callerSignal: options?.signal,
      attempt: (target) => this.generateWithTarget(input, options, target),
    });
  }

  private async generateWithTarget(
    input: ImageGenerateInput,
    options: RequestOptions | undefined,
    target: ResolvedRequestTarget,
  ): Promise<ImageGenerateResult> {
    const generation = createGenerationObservation({
      operation: "images.generate",
      payload: input,
      options,
      target,
    });
    await emitGenerationStart(this.config, generation.start);
    try {
      const result = await runBridgeImageGeneration({
        config: this.config,
        target,
        payload: input,
        options,
      });
      if (result.observation) {
        result.observation.traceId = generation.start.traceId;
        result.observation.spanId = generation.spanId;
      }
      await emitGenerationEnd(this.config, {
        traceId: generation.start.traceId,
        spanId: generation.spanId,
        endedAt: new Date().toISOString(),
        latencyMs: Date.now() - generation.startedAtMs,
        output: {
          model: result.model,
          imageCount: result.images.length,
          provider: result.provider,
          providerModel: result.providerModel,
          routeDecision: result.routeDecision,
        },
        usage: result.usage,
        observation: result.observation,
        rawCaptureMode: "provider_wire",
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
