import { resolveRequestTarget } from "../config";
import { normalizeGatewayError } from "../errors";
import { runBridgeImageGeneration } from "../bridge/images";
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
} from "../types";

export class ModelGatewayImagesEndpoint {
  constructor(private readonly config: ResolvedModelGatewayConfig) {}

  async generate(
    input: ImageGenerateInput,
    options?: RequestOptions,
  ): Promise<ImageGenerateResult> {
    const target = await resolveRequestTarget(this.config, input);
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
