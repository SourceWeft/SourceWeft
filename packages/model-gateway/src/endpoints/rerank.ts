import { normalizeGatewayError } from "../errors";
import { runBridgeRerank } from "../bridge/rerank";
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
  RerankInput,
  RerankResult,
  ResolvedModelGatewayConfig,
} from "../types";

export class ModelGatewayRerankEndpoint {
  constructor(private readonly config: ResolvedModelGatewayConfig) {}

  async rank(
    input: RerankInput,
    options?: RequestOptions,
  ): Promise<RerankResult> {
    return runWithTargetFailover({
      config: this.config,
      payload: input,
      operation: "rerank.rank",
      callerSignal: options?.signal,
      attempt: async (target) => {
        const generation = createGenerationObservation({
          operation: "rerank.rank",
          payload: input,
          options,
          target,
        });
        await emitGenerationStart(this.config, generation.start);
        try {
          const result = await runBridgeRerank({
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
              results: result.results,
              resultCount: result.results.length,
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
      },
    });
  }
}
