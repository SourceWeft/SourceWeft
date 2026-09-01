import type { UsageInfo } from "@sourceweft/model-gateway";
import type { ContentBillingPort } from "./billing-port";
import type { LlmExecutionConfig } from "./model-gateway-audit";
import { computeProviderCost, type ProviderCostResult } from "./provider-cost";
import type { ModelProfileKind } from "./types";

const MIN_BILLABLE_MODEL_CREDITS = 1;
const NON_USER_BILLED_MODEL_KINDS = new Set<ModelProfileKind>([
  "embedding",
  "rerank",
]);

export type MeterBillableModelUsageResult = {
  billing: Awaited<ReturnType<ContentBillingPort["meterConsume"]>>;
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
  const summary = await input.billing.getSummary(
    input.teamId,
    input.actorUserId,
  );
  const zeroBilling = {
    teamId: input.teamId,
    consumedCredits: 0,
    availableCredits: summary.credits.available,
    consumedThisCycle: summary.credits.consumedThisCycle,
    idempotencyReplayed: false,
  };

  if (NON_USER_BILLED_MODEL_KINDS.has(input.modelKind)) {
    return {
      billing: zeroBilling,
      cost: {
        providerCostUsd: 0,
        pricingSnapshot: null,
        costSource: "missing_or_zero_price",
        missingPriceComponents: [],
      },
      billedBy: "skipped",
      skipReason: "model_kind_not_user_billed",
    };
  }

  const cost = await computeProviderCost({
    gatewayConfigId: input.gatewayConfigId,
    modelKind: input.modelKind,
    profileAlias: input.profileAlias,
    usage: input.usage,
    llm: input.llm,
    allowPriceBookFallback: input.allowPriceBookFallback,
  });

  if (cost.providerCostUsd && cost.providerCostUsd > 0) {
    const billing = await input.billing.meterConsume(
      input.teamId,
      {
        workspaceId: input.workspaceId,
        feature: input.feature,
        referenceId: input.referenceId,
        idempotencyKey: input.idempotencyKey,
        providerCostUsd: cost.providerCostUsd,
        platformCostUsd: 0,
        modelKind: input.modelKind,
        operation: input.operation,
        metadata: {
          billedBy: "provider_cost",
          costSource: cost.costSource,
          missingPriceComponents: cost.missingPriceComponents,
          modelAlias: input.modelAlias ?? null,
          profileAlias: input.profileAlias,
          pricingSnapshot: cost.pricingSnapshot,
          providerActualCostUsd: input.usage?.providerCostUsd ?? null,
          providerCostSource: input.usage?.providerCostSource ?? null,
          providerCostDetails: input.usage?.costDetails ?? null,
          ...(input.metadata ?? {}),
        },
      },
      input.actorUserId,
    );

    return {
      billing,
      cost,
      billedBy: "provider_cost",
      skipReason: null,
    };
  }

  // BYOK is classified two ways: by the per-request execution mode, and by the
  // `modelGatewayConfigs.isBYOK` DB flag resolved inside computeProviderCost.
  // Both surface as costSource === "byok". Checking only executionMode let
  // gateway-level BYOK fall through to the minimum-credit floor below.
  if (input.llm?.executionMode === "BYOK" || cost.costSource === "byok") {
    return {
      billing: zeroBilling,
      cost,
      billedBy: "skipped",
      skipReason: "byok",
    };
  }

  const billing = await input.billing.meterConsume(
    input.teamId,
    {
      workspaceId: input.workspaceId,
      feature: input.feature,
      referenceId: input.referenceId,
      idempotencyKey: input.idempotencyKey,
      credits: MIN_BILLABLE_MODEL_CREDITS,
      modelKind: input.modelKind,
      operation: input.operation,
      metadata: {
        billedBy: "minimum_credit",
        costSource: cost.costSource,
        missingPriceComponents: cost.missingPriceComponents,
        minimumCredits: MIN_BILLABLE_MODEL_CREDITS,
        modelAlias: input.modelAlias ?? null,
        profileAlias: input.profileAlias,
        pricingSnapshot: cost.pricingSnapshot,
        providerCostUsd: cost.providerCostUsd,
        minimumCreditReason:
          cost.costSource === "missing_provider_actual"
            ? "missing_provider_actual"
            : cost.costSource === "missing_price_components"
              ? "missing_price_components"
              : cost.providerCostUsd === null
                ? "missing_usage"
                : "missing_or_zero_price",
        providerActualCostUsd: input.usage?.providerCostUsd ?? null,
        providerCostSource: input.usage?.providerCostSource ?? null,
        providerCostDetails: input.usage?.costDetails ?? null,
        ...(input.metadata ?? {}),
      },
    },
    input.actorUserId,
  );

  return {
    billing,
    cost,
    billedBy: "minimum_credit",
    skipReason: null,
  };
}
