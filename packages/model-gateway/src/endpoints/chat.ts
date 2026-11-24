import { resolveRequestOptions } from "../request-options";
import {
  ModelGatewayError,
  normalizeGatewayError,
  toGatewayErrorData,
} from "../errors";
import {
  planCandidates,
  startFailoverRun,
  type FailoverRun,
} from "../failover-policy";
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
        const requestOptions = resolveRequestOptions(
          this.config,
          target,
          options,
        );
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
              id: result.id,
              model: result.model,
              finishReason: result.finishReason,
              reasoning: result.reasoning,
              provider: result.provider,
              routeDecision: result.routeDecision,
              // The mechanism used and any fallback reason; never content.
              ...(result.structuredOutputDiagnostics
                ? { structuredOutput: result.structuredOutputDiagnostics }
                : {}),
            },
            outputText:
              typeof result.raw.content === "string"
                ? result.raw.content
                : undefined,
            finishReason: result.finishReason,
            reasoningText: result.reasoning,
            providerFields: result.providerFields,
            observation: result.observation,
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
    const run = startFailoverRun(
      this.config,
      await planCandidates(this.config, input),
      "chat.stream",
    );
    for (;;) {
      const target = run.current()!;
      const outcome = yield* this.streamAttempt(input, options, target, run);
      if (outcome === "done") {
        return;
      }
    }
  }

  /**
   * One target's streaming attempt. Fails over only while nothing has been
   * yielded to the consumer: once any event is out, the attempt is committed
   * and a later failure ends the stream just as it does today. The bridge
   * surfaces failures as terminal `{type: "error"}` events rather than
   * throws, so the failover check lives on the event, not in a catch block.
   *
   * Whether to fail over and which error the consumer sees is the shared
   * policy's call (`FailoverRun.failed`); this attempt's own generation
   * records its own error.
   */
  private async *streamAttempt(
    input: ChatStreamInput,
    options: RequestOptions | undefined,
    target: ResolvedRequestTarget,
    run: FailoverRun,
  ): AsyncGenerator<ChatStreamEvent, "done" | "next"> {
    const requestOptions = resolveRequestOptions(this.config, target, options);
    const generation = createGenerationObservation({
      operation: "chat.stream",
      payload: input,
      options: requestOptions,
      target,
    });
    await emitGenerationStart(this.config, generation.start);
    let completed = false;
    let yielded = false;
    let finalMetadata: Extract<
      ChatStreamEvent,
      { type: "metadata" }
    >["metadata"] = {};

    try {
      for await (const event of runBridgeChatStream({
        config: this.config,
        target,
        payload: input,
        options: {
          ...requestOptions,
          suppressLangChainObservation: true,
        },
        onFinalMetadata: (metadata) => {
          finalMetadata = metadata;
          if (metadata.observation) {
            metadata.observation.traceId = generation.start.traceId;
            metadata.observation.spanId = generation.spanId;
          }
        },
      })) {
        if (event.type === "metadata") {
          if (event.metadata.observation) {
            event.metadata.observation.traceId = generation.start.traceId;
            event.metadata.observation.spanId = generation.spanId;
          }
          completed = true;
          run.succeeded(target);
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
            observation: event.metadata.observation,
            usage: event.metadata.usage,
            rawCaptureMode: "sdk_metadata",
            providerResponse: toProviderResponse(event.metadata.providerFields),
            attributes: generation.start.attributes,
          });
        }

        let eventToYield = event;
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
            usage: finalMetadata.usage,
            observation: finalMetadata.observation,
            providerFields: finalMetadata.providerFields,
            attributes: generation.start.attributes,
          });
          const failure = new ModelGatewayError({ ...event.error });
          const decision = run.failed(target, failure, {
            callerAborted: options?.signal?.aborted ?? false,
            committed: yielded,
          });
          if (decision.next) {
            // Swallow the error event: the consumer never saw this attempt,
            // so the next target starts a clean stream.
            return "next";
          }
          if (decision.surfaced !== failure) {
            eventToYield = {
              type: "error",
              error: toGatewayErrorData(decision.surfaced),
            };
          }
        }

        yielded = true;
        yield eventToYield;
      }
    } catch (error) {
      if (!completed) {
        completed = true;
        await emitGenerationError(this.config, {
          ...buildGenerationErrorEvent({
            traceId: generation.start.traceId,
            spanId: generation.spanId,
            startedAtMs: generation.startedAtMs,
            error,
            attributes: generation.start.attributes,
          }),
          usage: finalMetadata.usage,
          observation: finalMetadata.observation,
          providerFields: finalMetadata.providerFields,
        });
      }
      throw error;
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
          usage: finalMetadata.usage,
          observation: finalMetadata.observation,
          providerFields: finalMetadata.providerFields,
          attributes: generation.start.attributes,
        });
      }
    }

    return "done";
  }
}
