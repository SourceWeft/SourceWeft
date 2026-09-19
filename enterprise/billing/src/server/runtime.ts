import type {
  BillingOrganizationHooks,
  BillingRuntime,
  SettleModelUsageInput,
  ModelSettlement,
} from "@sourceweft/contracts/billing-runtime";
import type { BillingService } from "./service";

/** Existing customer charging policy; provider cost observation remains host-owned. */
export function createBillingRuntime(service: BillingService): BillingRuntime {
  return {
    async getExecutionState(teamId, actorUserId) {
      const summary = await service.getSummary(teamId, actorUserId);
      return {
        kind: "metered",
        mode: summary.billingMode,
        availableCredits: summary.credits.available,
        consumedThisCycle: summary.credits.consumedThisCycle,
      };
    },
    settleModelUsage: (input) => settleModelUsage(service, input),
    async meterIngestion(teamId, input, actorUserId) {
      return {
        status: "settled",
        billing: await service.meterIngestion(teamId, input, actorUserId),
      };
    },
    async reconcileProviderCost(input) {
      return {
        status: "settled",
        ...(await service.reconcileModelProviderCost(input)),
      };
    },
  };
}

async function settleModelUsage(
  service: BillingService,
  input: SettleModelUsageInput,
): Promise<ModelSettlement> {
  if (input.modelKind === "embedding" || input.modelKind === "rerank") {
    return { status: "skipped", reason: "model_kind_not_user_billed" };
  }
  const cost =
    typeof input.cost === "function" ? await input.cost() : input.cost;
  const metadata = {
    costSource: cost.costSource,
    missingPriceComponents: cost.missingPriceComponents,
    modelAlias: input.modelAlias ?? null,
    profileAlias: input.profileAlias,
    pricingSnapshot: cost.pricingSnapshot,
    providerActualCostUsd: input.providerActualCostUsd ?? null,
    providerCostSource: input.providerCostSource ?? null,
    providerCostDetails: input.providerCostDetails ?? null,
  };
  const request = {
    workspaceId: input.workspaceId,
    feature: input.feature,
    referenceId: input.referenceId,
    idempotencyKey: input.idempotencyKey,
    modelKind: input.modelKind,
    operation: input.operation,
  };
  if (cost.providerCostUsd && cost.providerCostUsd > 0) {
    return {
      status: "settled",
      billedBy: "provider_cost",
      billing: await service.meterConsume(
        input.teamId,
        {
          ...request,
          providerCostUsd: cost.providerCostUsd,
          platformCostUsd: 0,
          metadata: {
            billedBy: "provider_cost",
            ...metadata,
            ...input.metadata,
          },
        },
        input.actorUserId,
      ),
    };
  }
  if (input.executionMode === "BYOK" || cost.costSource === "byok") {
    return { status: "skipped", reason: "byok" };
  }
  return {
    status: "settled",
    billedBy: "minimum_credit",
    billing: await service.meterConsume(
      input.teamId,
      {
        ...request,
        credits: 1,
        metadata: {
          billedBy: "minimum_credit",
          ...metadata,
          minimumCredits: 1,
          providerCostUsd: cost.providerCostUsd,
          minimumCreditReason:
            cost.costSource === "missing_provider_actual"
              ? "missing_provider_actual"
              : cost.costSource === "missing_price_components"
                ? "missing_price_components"
                : cost.providerCostUsd === null
                  ? "missing_usage"
                  : "missing_or_zero_price",
          ...input.metadata,
        },
      },
      input.actorUserId,
    ),
  };
}

export function createBillingOrganizationHooks(
  service: BillingService,
): BillingOrganizationHooks {
  return {
    async provisionAccount(teamId, userId) {
      await service.ensureBillingAccount(teamId, userId);
    },
    async beforeAddMember(teamId) {
      await service.assertCanAddTeamMember(teamId);
    },
    async beforeInviteMember(teamId) {
      await service.assertCanInviteTeamMember(teamId);
    },
    async beforeAcceptInvitation(teamId) {
      await service.assertCanAcceptTeamInvitation(teamId);
    },
  };
}
