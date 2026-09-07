import { resolveRequestOptions } from "../request-options";
import { normalizeGatewayError } from "../errors";
import { runBridgeAsrTranscription } from "../bridge/asr";
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
  AsrTranscribeInput,
  AsrTranscribeResult,
  RequestOptions,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
} from "../types";

export class ModelGatewayAsrEndpoint {
  constructor(private readonly config: ResolvedModelGatewayConfig) {}

  async transcribe(
    input: AsrTranscribeInput,
    options?: RequestOptions,
  ): Promise<AsrTranscribeResult> {
    return runWithTargetFailover({
      config: this.config,
      payload: input,
      operation: "asr.transcribe",
      callerSignal: options?.signal,
      attempt: (target) =>
        this.transcribeWithTarget(
          input,
          resolveRequestOptions(this.config, target, options),
          target,
        ),
    });
  }

  private async transcribeWithTarget(
    input: AsrTranscribeInput,
    options: RequestOptions | undefined,
    target: ResolvedRequestTarget,
  ): Promise<AsrTranscribeResult> {
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
