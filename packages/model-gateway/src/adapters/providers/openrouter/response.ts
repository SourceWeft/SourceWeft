import type {
  ModelCallObservationPatch,
  ProviderResponseAdapter,
  ProviderResponseContext,
} from "../../../observation/types";
import {
  finiteNumber,
  isRecord,
} from "../../../normalize/protocols/openai-compatible";

function numericCostDetails(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).flatMap(([key, item]) => {
    const numeric = finiteNumber(item);
    return numeric === undefined ? [] : [[key, numeric] as const];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeOpenRouterResponse(
  context: ProviderResponseContext,
): ModelCallObservationPatch | undefined {
  const usage = context.rawUsage;
  if (!usage) {
    return undefined;
  }

  const costDetails = numericCostDetails(usage.cost_details);
  const exactCost =
    finiteNumber(usage.cost) ??
    costDetails?.upstream_inference_cost ??
    costDetails?.upstream_cost ??
    costDetails?.inference_cost;
  const estimatedCost = finiteNumber(usage.estimated_cost);
  const costUsd = exactCost ?? estimatedCost;
  if (costUsd === undefined && !costDetails) {
    return undefined;
  }

  const sourcePath =
    finiteNumber(usage.cost) !== undefined
      ? "usage.cost"
      : costDetails?.upstream_inference_cost !== undefined
        ? "usage.cost_details.upstream_inference_cost"
        : costDetails?.upstream_cost !== undefined
          ? "usage.cost_details.upstream_cost"
          : costDetails?.inference_cost !== undefined
            ? "usage.cost_details.inference_cost"
            : "usage.estimated_cost";
  const source =
    exactCost !== undefined
      ? ("provider_inline" as const)
      : ("provider_estimated" as const);

  return {
    ...(costUsd !== undefined
      ? {
          cost: {
            currency: "USD" as const,
            inlineUsd: costUsd,
            effectiveUsd: costUsd,
            source,
            status:
              exactCost !== undefined
                ? ("inline" as const)
                : ("estimated" as const),
          },
          provenance: { inlineCost: `provider:openrouter.${sourcePath}` },
        }
      : {}),
    ...(costDetails ? { usage: { costDetails } } : {}),
  };
}

export const openRouterProviderAdapter: ProviderResponseAdapter = {
  normalizeResponse: (context) => normalizeOpenRouterResponse(context),
  costCapabilities: {
    actualCostMode: "inline",
    allowPriceBookFallback: true,
  },
};
