import type { UsageInfo } from "@sourceweft/model-gateway";
import type { ContentBillingPort } from "./billing-port";
import type { LlmExecutionConfig } from "./model-gateway-audit";
import { computeProviderCost, type ProviderCostResult } from "./provider-cost";
import type { ModelProfileKind } from "./types";

export type MeterBillableModelUsageResult = {
  billing: import("@sourceweft/contracts").MeterConsumeResponse | undefined;
  cost: ProviderCostResult;
  billedBy: "provider_cost" | "minimum_credit" | "skipped";
  skipReason: string | null;
};

export async function meterBillableModelUsage(input: {
  billing: ContentBillingPort;
  teamId: string;
  workspaceId?: string;
  actorUserId: string;
  feature: string;
  operation: string;
  modelKind: ModelProfileKind;
  gatewayConfigId: string;
  profileAlias: string;
  modelAlias?: string | null;
  referenceId?: string;
  idempotencyKey?: string;
  usage?: UsageInfo;
  llm?: LlmExecutionConfig;
  allowPriceBookFallback?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<MeterBillableModelUsageResult> {
  let cost: ProviderCostResult = {
    providerCostUsd: 0,
    pricingSnapshot: null,
    costSource: "missing_or_zero_price",
    missingPriceComponents: [],
  };
  const resolveCost = async () => {
    cost = await computeProviderCost({
      gatewayConfigId: input.gatewayConfigId,
      modelKind: input.modelKind,
      profileAlias: input.profileAlias,
      usage: input.usage,
      llm: input.llm,
      allowPriceBookFallback: input.allowPriceBookFallback,
    });

    return cost;
  };
  const result = await input.billing.settleModelUsage({
    teamId: input.teamId,
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    feature: input.feature,
    operation: input.operation,
    modelKind: input.modelKind,
    profileAlias: input.profileAlias,
    modelAlias: input.modelAlias,
    referenceId: input.referenceId,
    idempotencyKey: input.idempotencyKey,
    executionMode: input.llm?.executionMode,
    cost: resolveCost,
    providerActualCostUsd: input.usage?.providerCostUsd,
    providerCostSource: input.usage?.providerCostSource,
    providerCostDetails: input.usage?.costDetails,
    metadata: input.metadata,
  });
  return result.status === "settled"
    ? {
        billing: result.billing,
        cost,
        billedBy: result.billedBy,
        skipReason: null,
      }
    : {
        billing: undefined,
        cost,
        billedBy: "skipped",
        skipReason: result.reason,
      };
}
