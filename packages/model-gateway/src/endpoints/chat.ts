import { resolveRequestTarget } from "../config";
import { normalizeGatewayError } from "../errors";
import { runBridgeChatComplete, runBridgeChatStream } from "../bridge/chat";
import {
  buildGenerationErrorEvent,
  createGenerationObservation,
  emitGenerationEnd,
  emitGenerationError,
  emitGenerationStart,
  toProviderResponse,
} from "../observe/generation";
import type {
  ChatCompleteInput,
  ChatCompleteResult,
  ChatStreamEvent,
  ChatStreamInput,
  RequestOptions,
  ResolvedModelGatewayConfig,
} from "../types";

export class ModelGatewayChatEndpoint {
  constructor(private readonly config: ResolvedModelGatewayConfig) {}

  private resolveRequestOptions(options?: RequestOptions): RequestOptions {
    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options?.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    return {
      ...options,
      timeoutMs,
      maxRetries: options?.maxRetries ?? this.config.maxRetries,
      signal,
    };
  }

  async complete(
    input: ChatCompleteInput,
    options?: RequestOptions,
  ): Promise<ChatCompleteResult> {
    const requestOptions = this.resolveRequestOptions(options);
    const target = await resolveRequestTarget(this.config, input);
    const generation = createGenerationObservation({
      operation: "chat.complete",
      payload: input,
      options: requestOptions,
      target,
    });
    await emitGenerationStart(this.config, generation.start);
    try {
      const result = await runBridgeChatComplete({
        config: this.config,
        target,
        payload: input,
        options: {
          ...requestOptions,
          suppressLangChainObservation: true,
        },
      });
      await emitGenerationEnd(this.config, {
        traceId: generation.start.traceId,
        spanId: generation.spanId,
        endedAt: new Date().toISOString(),
        latencyMs: Date.now() - generation.startedAtMs,
        output: {
          id: result.id,
          model: result.model,
          finishReason: result.finishReason,
          reasoning: result.reasoning,
          provider: result.provider,
          routeDecision: result.routeDecision,
        },
        outputText:
          typeof result.raw.content === "string" ? result.raw.content : undefined,
        finishReason: result.finishReason,
        reasoningText: result.reasoning,
        providerFields: result.providerFields,
        usage: result.usage,
        rawCaptureMode: "sdk_metadata",
        providerResponse: toProviderResponse(result.providerFields),
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

  async *stream(
    input: ChatStreamInput,
    options?: RequestOptions,
  ): AsyncGenerator<ChatStreamEvent> {
    const requestOptions = this.resolveRequestOptions(options);
    const target = await resolveRequestTarget(this.config, input);
    const generation = createGenerationObservation({
      operation: "chat.stream",
      payload: input,
      options: requestOptions,
      target,
    });
    await emitGenerationStart(this.config, generation.start);
    let completed = false;
    let yielded = false;

    try {
      for await (const event of runBridgeChatStream({
        config: this.config,
        target,
        payload: input,
        options: {
          ...requestOptions,
          suppressLangChainObservation: true,
        },
      })) {
        if (event.type === "metadata") {
          completed = true;
          await emitGenerationEnd(this.config, {
            traceId: generation.start.traceId,
            spanId: generation.spanId,
            endedAt: new Date().toISOString(),
            latencyMs: Date.now() - generation.startedAtMs,
            output: {
              finishReason: event.metadata.finishReason,
              reasoning: event.metadata.reasoning,
              routeDecision: event.metadata.routeDecision,
            },
            finishReason: event.metadata.finishReason,
            reasoningText: event.metadata.reasoning,
            providerFields: event.metadata.providerFields,
            usage: event.metadata.usage,
            rawCaptureMode: "sdk_metadata",
            providerResponse: toProviderResponse(event.metadata.providerFields),
            attributes: generation.start.attributes,
          });
        }

        if (event.type === "error") {
          completed = true;
          await emitGenerationError(this.config, {
            traceId: generation.start.traceId,
            spanId: generation.spanId,
            endedAt: new Date().toISOString(),
            latencyMs: Date.now() - generation.startedAtMs,
            errorCode: event.error.code,
            errorMessage: event.error.message,
            providerStatusCode: event.error.statusCode,
            providerRequestId: event.error.requestId,
            attributes: generation.start.attributes,
          });
        }

        yielded = true;
        yield event;
      }
    } finally {
      if (!completed) {
        await emitGenerationError(this.config, {
          traceId: generation.start.traceId,
          spanId: generation.spanId,
          endedAt: new Date().toISOString(),
          latencyMs: Date.now() - generation.startedAtMs,
          errorCode: yielded ? "CANCELLED" : "UNKNOWN",
          errorMessage: yielded
            ? "Chat stream cancelled before completion"
            : "Chat stream ended without metadata",
          attributes: generation.start.attributes,
        });
      }
    }
  }
}
