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

function roundUsd(value: number) {
  return Number(value.toFixed(12));
}

/**
 * OpenRouter BYOK: the call ran on our own upstream key, so the upstream
 * provider bills that key directly and `usage.cost` is only OpenRouter's fee
 * (often 0). The platform cost is the fee plus the upstream charge. Without an
 * upstream figure the fee is kept as the amount already charged and the total
 * is left open for the caller to complete from the price book.
 */
function normalizeOpenRouterByokCost(
  usage: Record<string, unknown>,
  costDetails: Record<string, number> | undefined,
): ModelCallObservationPatch {
  const fee = finiteNumber(usage.cost);
  const upstream = costDetails?.upstream_inference_cost;
  const details = costDetails ? { usage: { costDetails } } : {};
  if (upstream !== undefined) {
    const total = roundUsd((fee ?? 0) + upstream);
    return {
      cost: {
        currency: "USD",
        inlineUsd: total,
        effectiveUsd: total,
        source: "provider_inline",
        status: "inline",
      },
      provenance: {
        inlineCost:
          "provider:openrouter.usage.cost+usage.cost_details.upstream_inference_cost",
      },
      ...details,
    };
  }
  if (fee === undefined) {
    return details;
  }
  return {
    cost: {
      currency: "USD",
      inlineUsd: fee,
      source: "provider_inline",
      // No receipt follows an inline provider: the caller estimates the rest.
      status: "estimated",
    },
    provenance: { inlineCost: "provider:openrouter.usage.cost" },
    ...details,
  };
}

function normalizeOpenRouterResponse(
  context: ProviderResponseContext,
): ModelCallObservationPatch | undefined {
  const usage = context.rawUsage;
  if (!usage) {
    return undefined;
  }

  const costDetails = numericCostDetails(usage.cost_details);
  if (usage.is_byok === true) {
    return normalizeOpenRouterByokCost(usage, costDetails);
  }
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
