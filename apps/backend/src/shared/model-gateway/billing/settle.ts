import type { BillingMode } from "@sourceweft/contracts";
import {
  getProviderResponseAdapter,
  type ModelCallObservation,
  type UsageInfo,
} from "@sourceweft/model-gateway";
import { logger } from "../../logger";
import type { ContentBillingPort } from "../../../modules/content/billing-port";
import { meterBillableModelUsage } from "../../../modules/content/model-billing";
import { resolveGatewayObservedIdentity } from "../../../modules/content/model-gateway-audit";
import type {
  MeteredModelCallTrace,
  ModelCallBillingOptions,
  ModelUsageContext,
} from "./context";

export type MeterUsageFn = typeof meterBillableModelUsage;

export type ScheduleProviderCostReconciliationFn = (input: {
  observation?: ModelCallObservation;
  teamId: string;
  workspaceId?: string;
  actorUserId?: string;
  feature: string;
  gatewayConfigId: string;
  originalBillingIdempotencyKey?: string;
}) => Promise<unknown>;

/**
 * Usage that is entirely empty means the provider told us nothing — there is
 * nothing to charge for and no cost to record.
 */
export function hasReportableUsage(usage: UsageInfo | undefined) {
  if (!usage) {
    return false;
  }
  return Object.values(usage).some((value) => value !== undefined);
}

function compactBillingError(error: unknown) {
  if (error instanceof Error) {
    return error.message.split("\n", 1)[0]?.slice(0, 320) || error.name;
  }
  return String(error).split("\n", 1)[0]?.slice(0, 320) || "Unknown error";
}

/**
 * Absent or unreadable billing state is treated as enforced, so a failure to
 * determine the mode fails closed rather than silently granting free usage.
 */
export type SettleModelCallInput = {
  context: ModelUsageContext;
  billing: ContentBillingPort;
  options: ModelCallBillingOptions;
  usage: UsageInfo | undefined;
  observation?: ModelCallObservation;
  idempotencyKey: string;
  referenceId: string;
  /** Injected for tests; production uses the real metering funnel. */
  meterUsage?: MeterUsageFn;
  scheduleReconciliation?: ScheduleProviderCostReconciliationFn;
};

/**
 * The single place model usage turns into a credit deduction.
 *
 * Runs inside the caller's await chain on both the client and LangChain paths,
 * so an enforced-mode metering failure actually propagates and aborts the work
 * rather than being swallowed by a fire-and-forget observer.
 */
export async function settleModelCall(
  input: SettleModelCallInput,
): Promise<MeteredModelCallTrace | null> {
  if (!hasReportableUsage(input.usage)) {
    return null;
  }

  const { context, options } = input;
  const scheduleReconciliation = async (
    originalBillingIdempotencyKey?: string,
  ) => {
    if (!input.scheduleReconciliation || !input.observation) {
      return;
    }
    try {
      await input.scheduleReconciliation({
        observation: input.observation,
        teamId: context.teamId,
        workspaceId: context.workspaceId,
        actorUserId: context.actorUserId,
        feature: context.feature,
        gatewayConfigId: options.gatewayConfigId,
        originalBillingIdempotencyKey,
      });
    } catch (error) {
      logger.warn("Failed to schedule provider cost reconciliation", {
        teamId: context.teamId,
        provider: input.observation.identity.provider,
        providerRequestId: input.observation.identity.providerRequestId,
        traceId: input.observation.traceId,
        spanId: input.observation.spanId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const observedIdentity = resolveGatewayObservedIdentity({
    llm: options.llm,
    modelAlias: options.modelAlias,
    profileAlias: options.profileAlias,
  });

  const baseTrace = {
    id: input.idempotencyKey,
    operation: options.operation,
    modelKind: options.modelKind,
    modelAlias: observedIdentity.modelAlias,
    profileAlias: observedIdentity.profileAlias,
    gatewayConfigId: options.gatewayConfigId,
    usage: input.usage,
    observation: input.observation,
    idempotencyKey: input.idempotencyKey,
    referenceId: input.referenceId,
  } satisfies Partial<MeteredModelCallTrace>;

  const metadata: Record<string, unknown> = {
    teamId: context.teamId,
    workspaceId: context.workspaceId ?? null,
    threadId: context.threadId ?? null,
    messageId: context.messageId ?? null,
    scopeKind: context.scopeKind,
    scopeId: context.scopeId,
    operation: options.operation,
    modelKind: options.modelKind,
    modelAlias: observedIdentity.modelAlias,
    profileAlias: observedIdentity.profileAlias,
    catalogModelAlias: observedIdentity.catalogModelAlias ?? null,
    catalogProfileAlias: observedIdentity.catalogProfileAlias ?? null,
    providerModel: options.llm?.providerModel ?? null,
    usage: input.usage,
    ...(options.billingMetadata ?? {}),
  };

  // Covered calls are deliberately free to the customer. Their cost is still
  // captured, but by the observability sink against the generation row, so no
  // ledger entry is written and no pricing lookup is repeated here.
  if (context.intent.mode === "covered") {
    await scheduleReconciliation();
    return {
      ...baseTrace,
      billingStatus: "covered",
      consumedCredits: 0,
      coveredBy: context.intent.coveredBy,
      metadata: { ...metadata, coveredBy: context.intent.coveredBy },
    };
  }

  let billingMode: BillingMode = "enforced";

  try {
    const state = await input.billing.getExecutionState(
      context.teamId,
      context.actorUserId,
    );
    billingMode = state.kind === "unmetered" ? "disabled" : state.mode;

    const meterUsage = input.meterUsage ?? meterBillableModelUsage;
    const providerAdapter = input.observation
      ? getProviderResponseAdapter(input.observation.identity.provider)
      : undefined;
    const metered = await meterUsage({
      billing: input.billing,
      teamId: context.teamId,
      workspaceId: context.workspaceId,
      actorUserId: context.actorUserId,
      feature: context.feature,
      operation: options.operation,
      modelKind: options.modelKind,
      gatewayConfigId: options.gatewayConfigId,
      profileAlias: options.profileAlias,
      modelAlias: options.modelAlias,
      referenceId: input.referenceId,
      idempotencyKey: input.idempotencyKey,
      usage: input.usage,
      llm: options.llm,
      allowPriceBookFallback:
        providerAdapter?.costCapabilities?.allowPriceBookFallback,
      metadata,
    });

    await scheduleReconciliation(
      metered.billedBy === "skipped" ? undefined : input.idempotencyKey,
    );

    return {
      ...baseTrace,
      billingStatus: metered.billedBy === "skipped" ? "skipped" : "metered",
      consumedCredits: metered.billing?.consumedCredits ?? 0,
      billedBy: metered.billedBy,
      skipReason: metered.skipReason,
      providerCostUsd: metered.cost.providerCostUsd,
      costSource: metered.cost.costSource,
      missingPriceComponents: metered.cost.missingPriceComponents,
      pricingSnapshot: metered.cost.pricingSnapshot,
      billing: metered.billing
        ? {
            teamId: metered.billing.teamId,
            availableCredits: metered.billing.availableCredits,
            consumedThisCycle: metered.billing.consumedThisCycle,
            idempotencyReplayed: metered.billing.idempotencyReplayed,
          }
        : undefined,
      metadata: {
        ...metadata,
        billedBy: metered.billedBy,
        billingMode,
        costSource: metered.cost.costSource,
        missingPriceComponents: metered.cost.missingPriceComponents,
        pricingSnapshot: metered.cost.pricingSnapshot,
      },
    };
  } catch (error) {
    const errorMessage = compactBillingError(error);
    const trace: MeteredModelCallTrace = {
      ...baseTrace,
      billingStatus: "meter_failed",
      consumedCredits: 0,
      error: errorMessage,
      metadata: { ...metadata, billingMode, billingError: errorMessage },
    };

    logger.warn("Failed to meter model call usage", {
      teamId: context.teamId,
      workspaceId: context.workspaceId,
      scopeKind: context.scopeKind,
      scopeId: context.scopeId,
      operation: options.operation,
      idempotencyKey: input.idempotencyKey,
      billingMode,
      error: errorMessage,
    });

    if (billingMode === "enforced") {
      const meteringError = new Error(errorMessage);
      Object.assign(meteringError, {
        code: "LLM_CALL_METERING_FAILED",
        meteredLlmCall: trace,
        cause: error,
      });
      throw meteringError;
    }

    return trace;
  }
}
