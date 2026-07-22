import { normalizeGatewayError } from "../errors";
import { runBridgeTtsSpeech } from "../bridge/tts";
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
  RequestOptions,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
  TtsSpeechInput,
  TtsSpeechResult,
} from "../types";

export class ModelGatewayTtsEndpoint {
  constructor(private readonly config: ResolvedModelGatewayConfig) {}

  async speech(
    input: TtsSpeechInput,
    options?: RequestOptions,
  ): Promise<TtsSpeechResult> {
    return runWithTargetFailover({
      config: this.config,
      payload: input,
      operation: "tts.speech",
      callerSignal: options?.signal,
      attempt: (target) => this.speechWithTarget(input, options, target),
    });
  }

  private async speechWithTarget(
    input: TtsSpeechInput,
    options: RequestOptions | undefined,
    target: ResolvedRequestTarget,
  ): Promise<TtsSpeechResult> {
    const generation = createGenerationObservation({
      operation: "tts.speech",
      payload: input,
      options,
      target,
    });
    await emitGenerationStart(this.config, generation.start);
    try {
      const result = await runBridgeTtsSpeech({
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
          audioBytes: result.audio.byteLength,
          mimeType: result.mimeType,
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
