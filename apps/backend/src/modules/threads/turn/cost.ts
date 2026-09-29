// A turn's provider cost, built from the shared per-call kernel in
// ../../content/provider-cost.ts (which has no dependency on threads/
// internals); its functions are re-exported here for existing imports.

import {
  computeProviderCost,
  computeProviderCostFromPricing,
  createCachedProviderCostLookups,
  type ProviderCostLookups,
} from "../../content/provider-cost";
import type { LlmExecutionConfig } from "../../content/model-gateway-audit";
import type { MeteredLlmCallTrace } from "./types";

export {
  computeProviderCost,
  computeProviderCostFromPricing,
  type ProviderCostResult,
} from "../../content/provider-cost";

// The turn record is reporting, not billing: the cached reads are enough.
const cachedLookups = createCachedProviderCostLookups();

export type TurnProviderCost = {
  providerCostUsd: number | null;
  /** The calls' shared source, or `mixed` when they differ. */
  costSource: string;
  missingPriceComponents: string[];
  /** Only for a single-call turn; several calls have several price entries. */
  pricingSnapshot: unknown;
};

async function callCost(
  call: MeteredLlmCallTrace,
  llm: LlmExecutionConfig | undefined,
  lookups: ProviderCostLookups,
) {
  // A billed call was costed with the uncached reads; keep that figure.
  if (call.billingStatus === "metered" && call.costSource !== undefined) {
    return {
      providerCostUsd: call.providerCostUsd ?? null,
      costSource: call.costSource,
      missingPriceComponents: call.missingPriceComponents ?? [],
      pricingSnapshot: call.pricingSnapshot ?? null,
    };
  }
  if (!call.profileAlias) {
    return {
      providerCostUsd: null,
      costSource: "missing_usage",
      missingPriceComponents: [],
      pricingSnapshot: null,
    };
  }
  return computeProviderCost({
    gatewayConfigId: call.gatewayConfigId,
    modelKind: call.modelKind,
    profileAlias: call.profileAlias,
    usage: call.usage,
    cost: call.observation?.cost,
    llm,
    lookups,
  });
}

function roundUsd(value: number) {
  return Number(value.toFixed(12));
}

/**
 * A turn's provider cost: each model call costed on its own — its provider's
 * reported total, or its own price entry — and summed. Pricing the turn's
 * summed usage at the chat model's price would charge a title or sub-agent
 * call at the wrong rate, and a reported cost from one call would stand in for
 * calls that reported none.
 */
export async function computeTurnProviderCost(input: {
  calls: readonly MeteredLlmCallTrace[];
  llm?: LlmExecutionConfig;
  lookups?: ProviderCostLookups;
}): Promise<TurnProviderCost> {
  if (input.calls.length === 0) {
    return {
      providerCostUsd: null,
      costSource: "missing_usage",
      missingPriceComponents: [],
      pricingSnapshot: null,
    };
  }
  const costs = await Promise.all(
    input.calls.map((call) =>
      callCost(call, input.llm, input.lookups ?? cachedLookups),
    ),
  );
  const known = costs.filter((cost) => cost.providerCostUsd !== null);
  const sources = new Set(costs.map((cost) => cost.costSource));
  return {
    providerCostUsd:
      known.length === 0
        ? null
        : roundUsd(
            known.reduce((sum, cost) => sum + (cost.providerCostUsd ?? 0), 0),
          ),
    costSource: sources.size === 1 ? [...sources][0]! : "mixed",
    missingPriceComponents: [
      ...new Set(costs.flatMap((cost) => cost.missingPriceComponents)),
    ],
    pricingSnapshot: costs.length === 1 ? costs[0]!.pricingSnapshot : null,
  };
}

export const testExports = {
  computeProviderCostFromPricing,
};
