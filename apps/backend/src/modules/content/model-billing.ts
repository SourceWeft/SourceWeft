import type { UsageInfo } from "@sourceweft/model-gateway";
import type { ContentBillingPort } from "./billing-port";
import type { LlmExecutionConfig } from "./model-gateway-audit";
import { computeProviderCost, type ProviderCostResult } from "./threads/turn/cost";
import type { ModelProfileKind } from "./threads/model-settings";

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
  metadata?: Record<string, unknown>;
}): Promise<MeterBillableModelUsageResult> {
  const summary = await input.billing.getSummary(input.teamId);
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
      cost: { providerCostUsd: 0, pricingSnapshot: null },
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
          modelAlias: input.modelAlias ?? null,
          profileAlias: input.profileAlias,
          pricingSnapshot: cost.pricingSnapshot,
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

  if (input.llm?.executionMode === "BYOK") {
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
        minimumCredits: MIN_BILLABLE_MODEL_CREDITS,
        modelAlias: input.modelAlias ?? null,
        profileAlias: input.profileAlias,
        pricingSnapshot: cost.pricingSnapshot,
        providerCostUsd: cost.providerCostUsd,
        minimumCreditReason:
          cost.providerCostUsd === null ? "missing_usage" : "missing_or_zero_price",
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
