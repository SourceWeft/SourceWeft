import { resolveRequestCandidates } from "../config";
import {
  isAdministrativeGatewayCode,
  isFailoverableCode,
  normalizeGatewayError,
  surfacedErrorRankForCode,
} from "../errors";
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
  GatewayErrorData,
  RequestOptions,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
} from "../types";

/** A stream attempt whose error event was swallowed in favor of failover. */
type FailedStreamAttempt = {
  provider: string;
  providerModel: string;
  error: GatewayErrorData;
};

/**
 * Data-level twin of `selectSurfacedFailoverError`: the most informative
 * error of the chain wins, earliest attempt on ties.
 */
function selectSurfacedStreamError(
  previousAttempts: readonly FailedStreamAttempt[],
  terminalError: GatewayErrorData,
): GatewayErrorData {
  let best = previousAttempts[0]?.error ?? terminalError;
  for (const attempt of previousAttempts.slice(1)) {
    if (
      surfacedErrorRankForCode(attempt.error.code) >
      surfacedErrorRankForCode(best.code)
    ) {
      best = attempt.error;
    }
  }
  return surfacedErrorRankForCode(terminalError.code) >
    surfacedErrorRankForCode(best.code)
    ? terminalError
    : best;
}

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
    const failedAttempts: FailedStreamAttempt[] = [];

    for (const [index, target] of candidates.entries()) {
      const hasNext = index < candidates.length - 1;
      const outcome = yield* this.streamAttempt(
        input,
        options,
        target,
        hasNext,
        failedAttempts,
      );
      if (outcome === "done") {
        return;
      }
      // Failover: nothing reached the consumer — record the swallowed error
      // (so a later terminal error can be out-ranked by it) and try the next
      // target.
      failedAttempts.push({
        provider: target.provider,
        providerModel: target.providerModel,
        error: outcome.failedWith,
      });
      this.config.logger.warn?.("model-gateway.failover", {
        operation: "chat.stream",
        alias: target.routeDecision.alias,
        failedProvider: target.provider,
        failedProviderModel: target.providerModel,
        errorCode: outcome.failedWith.code,
        nextProvider: candidates[index + 1]?.provider,
        attempt: index + 1,
        candidates: candidates.length,
      });
    }
  }

  /**
   * One target's streaming attempt. Fails over only while nothing has been
   * yielded to the consumer: once any event is out, the attempt is committed
   * and a later failure ends the stream just as it does today. The bridge
   * surfaces failures as terminal `{type: "error"}` events rather than
   * throws, so the failover check lives on the event, not in a catch block.
   *
   * A terminal error event is surfaced by informativeness, not recency: when
   * earlier targets failed with a substantive error and this last one is
   * merely administrative (an unfunded tail target's 402), the earlier error
   * is what the consumer sees — same policy as `selectSurfacedFailoverError`
   * on the complete path.
   */
  private async *streamAttempt(
    input: ChatStreamInput,
    options: RequestOptions | undefined,
    target: ResolvedRequestTarget,
    hasNext: boolean,
    previousAttempts: readonly FailedStreamAttempt[],
  ): AsyncGenerator<ChatStreamEvent, "done" | { failedWith: GatewayErrorData }> {
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

        let eventToYield = event;
        if (event.type === "error") {
          completed = true;
          let surfaced = event.error;
          if (previousAttempts.length > 0) {
            const candidate = selectSurfacedStreamError(
              previousAttempts,
              event.error,
            );
            if (candidate !== event.error) {
              this.config.logger.warn?.("model-gateway.failover-exhausted", {
                operation: "chat.stream",
                alias: target.routeDecision.alias,
                surfacedErrorCode: candidate.code,
                targetErrors: [
                  ...previousAttempts.map((attempt) => ({
                    provider: attempt.provider,
                    providerModel: attempt.providerModel,
                    code: attempt.error.code,
                    message: attempt.error.message.slice(0, 200),
                  })),
                  {
                    provider: target.provider,
                    providerModel: target.providerModel,
                    code: event.error.code,
                    message: event.error.message.slice(0, 200),
                  },
                ],
              });
              eventToYield = { type: "error", error: candidate };
              surfaced = candidate;
            }
          }
          await emitGenerationError(this.config, {
            traceId: generation.start.traceId,
            spanId: generation.spanId,
            endedAt: new Date().toISOString(),
            latencyMs: Date.now() - generation.startedAtMs,
            errorCode: surfaced.code,
            errorMessage: surfaced.message,
            providerStatusCode: surfaced.statusCode,
            providerRequestId: surfaced.requestId,
            attributes: generation.start.attributes,
          });
          if (
            isFailoverableCode(event.error.code) &&
            !options?.signal?.aborted
          ) {
            this.config.targetHealth.markFailure(target);
          }
          if (
            !options?.signal?.aborted &&
            isAdministrativeGatewayCode(event.error.code)
          ) {
            this.config.logger.warn?.("model-gateway.target-quota", {
              operation: "chat.stream",
              alias: target.routeDecision.alias,
              provider: target.provider,
              providerModel: target.providerModel,
              errorCode: event.error.code,
            });
          }
          if (
            !yielded &&
            hasNext &&
            !options?.signal?.aborted &&
            isFailoverableCode(event.error.code)
          ) {
            // Swallow the error event: the consumer never saw this attempt,
            // so the next target starts a clean stream.
            return { failedWith: event.error };
          }
        }

        yielded = true;
        yield eventToYield;
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
