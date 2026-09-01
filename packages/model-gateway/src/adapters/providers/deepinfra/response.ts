import type {
  ModelCallObservation,
  ModelCallObservationPatch,
  ProviderResponseAdapter,
  ProviderResponseContext,
} from "../../../observation/types";
import {
  finiteNumber,
  isRecord,
} from "../../../normalize/protocols/openai-compatible";

function normalizeDeepInfraResponse(
  context: ProviderResponseContext,
  base: ModelCallObservation,
): ModelCallObservationPatch | undefined {
  if (!isRecord(context.rawResponse)) {
    return undefined;
  }
  const status = isRecord(context.rawResponse.inference_status)
    ? context.rawResponse.inference_status
    : undefined;
  if (!status) {
    return undefined;
  }

  const inputTokens =
    base.usage?.inputTokens ??
    finiteNumber(context.rawResponse.input_tokens) ??
    finiteNumber(status.tokens_input) ??
    finiteNumber(status.input_tokens);
  const outputTokens =
    base.usage?.outputTokens ??
    finiteNumber(context.rawResponse.output_tokens) ??
    finiteNumber(status.tokens_generated) ??
    finiteNumber(status.output_tokens) ??
    finiteNumber(status.completion_tokens);
  const totalTokens =
    base.usage?.totalTokens ??
    finiteNumber(context.rawResponse.total_tokens) ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  const costUsd = finiteNumber(status.cost);

  return {
    usage: {
      inputTokens,
      outputTokens,
      totalTokens,
    },
    provenance: {
      usage: "provider:deepinfra.inference_status",
      ...(costUsd !== undefined
        ? { inlineCost: "provider:deepinfra.inference_status.cost" }
        : {}),
    },
    ...(costUsd !== undefined
      ? {
          cost: {
            currency: "USD" as const,
            inlineUsd: costUsd,
            effectiveUsd: costUsd,
            source: "provider_inline" as const,
            status: "inline" as const,
          },
        }
      : {}),
  };
}

export const deepInfraProviderAdapter: ProviderResponseAdapter = {
  normalizeResponse: normalizeDeepInfraResponse,
  costCapabilities: {
    actualCostMode: "inline",
    allowPriceBookFallback: true,
  },
};
