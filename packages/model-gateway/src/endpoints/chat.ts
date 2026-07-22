import { resolveRequestCandidates } from "../config";
import { isFailoverableCode, normalizeGatewayError } from "../errors";
import { runBridgeChatComplete, runBridgeChatStream } from "../bridge/chat";
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
  ChatCompleteInput,
  ChatCompleteResult,
  ChatStreamEvent,
  ChatStreamInput,
  RequestOptions,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
} from "../types";

export class ModelGatewayChatEndpoint {
  constructor(private readonly config: ResolvedModelGatewayConfig) {}

  /**
   * Composed fresh per attempt, not per request: the timeout budget belongs to
   * one target's try. Reusing one composed signal across failover attempts
   * would hand attempt two an already-spent (or nearly spent) budget.
   */
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
    return runWithTargetFailover({
      config: this.config,
      payload: input,
      operation: "chat.complete",
      callerSignal: options?.signal,
      attempt: async (target) => {
        const requestOptions = this.resolveRequestOptions(options);
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
      },
    });
  }

  async *stream(
    input: ChatStreamInput,
    options?: RequestOptions,
  ): AsyncGenerator<ChatStreamEvent> {
    const candidates = await resolveRequestCandidates(this.config, input);

    for (const [index, target] of candidates.entries()) {
      const hasNext = index < candidates.length - 1;
      const outcome = yield* this.streamAttempt(input, options, target, hasNext);
      if (outcome === "done") {
        return;
      }
      // "failover": nothing reached the consumer — try the next target.
      this.config.logger.warn?.("model-gateway.failover", {
        operation: "chat.stream",
        alias: target.routeDecision.alias,
        failedProvider: target.provider,
        failedProviderModel: target.providerModel,
        nextProvider: candidates[index + 1]?.provider,
        attempt: index + 1,
        candidates: candidates.length,
      });
    }
  }

  /**
   * One target's streaming attempt. Returns "failover" only while nothing has
   * been yielded to the consumer: once any event is out, the attempt is
   * committed and a later failure ends the stream just as it does today. The
   * bridge surfaces failures as terminal `{type: "error"}` events rather than
   * throws, so the failover check lives on the event, not in a catch block.
   */
  private async *streamAttempt(
    input: ChatStreamInput,
    options: RequestOptions | undefined,
    target: ResolvedRequestTarget,
    hasNext: boolean,
  ): AsyncGenerator<ChatStreamEvent, "done" | "failover"> {
    const requestOptions = this.resolveRequestOptions(options);
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
          this.config.targetHealth.markSuccess(target);
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
          if (
            isFailoverableCode(event.error.code) &&
            !options?.signal?.aborted
          ) {
            this.config.targetHealth.markFailure(target);
          }
          if (
            !yielded &&
            hasNext &&
            !options?.signal?.aborted &&
            isFailoverableCode(event.error.code)
          ) {
            // Swallow the error event: the consumer never saw this attempt,
            // so the next target starts a clean stream.
            return "failover";
          }
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

    return "done";
  }
}
