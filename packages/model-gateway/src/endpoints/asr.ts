import { resolveRequestTarget } from "../config";
import { normalizeGatewayError } from "../errors";
import { runBridgeAsrTranscription } from "../bridge/asr";
import {
  buildGenerationErrorEvent,
  createGenerationObservation,
  emitGenerationEnd,
  emitGenerationError,
  emitGenerationStart,
  toProviderResponse,
} from "../observe/generation";
import type {
  AsrTranscribeInput,
  AsrTranscribeResult,
  RequestOptions,
  ResolvedModelGatewayConfig,
} from "../types";

export class ModelGatewayAsrEndpoint {
  constructor(private readonly config: ResolvedModelGatewayConfig) {}

  async transcribe(
    input: AsrTranscribeInput,
    options?: RequestOptions,
  ): Promise<AsrTranscribeResult> {
    const target = await resolveRequestTarget(this.config, input);
    const generation = createGenerationObservation({
      operation: "asr.transcribe",
      payload: input,
      options,
      target,
    });
    await emitGenerationStart(this.config, generation.start);
    try {
      const result = await runBridgeAsrTranscription({
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
          textLength: result.text.length,
          language: result.language,
          duration: result.duration,
          inputLengthMs: result.inputLengthMs,
          segmentCount: result.segments?.length ?? 0,
          wordCount: result.words?.length ?? 0,
          provider: result.provider,
          providerModel: result.providerModel,
          routeDecision: result.routeDecision,
        },
        outputText: result.text,
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
