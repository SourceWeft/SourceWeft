import type { Job } from "bullmq";
import {
  getProviderResponseAdapter,
  type ModelCallObservation,
} from "@sourceweft/model-gateway";
import { db, llmGenerations, modelGatewayConfigs } from "@sourceweft/db";
import { and, eq } from "drizzle-orm";
import { billingService, isBillingError } from "../../modules/billing";
import { opsAlertService } from "../../modules/ops";
import { config } from "../config";
import { logger } from "../logger";
import { enqueueWithAudit } from "../queue";
import { decryptSecret } from "../secrets";
import { createLlmFetch, llmEndpointPolicy } from "./network";

export const RECONCILE_PROVIDER_COST_JOB = "reconcile-provider-cost";

export type ProviderCostReconciliationPayload = {
  teamId: string;
  workspaceId: string;
  actorUserId?: string;
  feature: string;
  traceId: string;
  spanId: string;
  gatewayConfigId: string;
  provider: string;
  providerRequestId: string;
  originalBillingIdempotencyKey?: string;
};

function requiredString(
  value: unknown,
  field: keyof ProviderCostReconciliationPayload,
) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Provider cost reconciliation payload is missing '${field}'`,
    );
  }
  return value.trim();
}

function parsePayload(
  input: Record<string, unknown>,
): ProviderCostReconciliationPayload {
  return {
    teamId: requiredString(input.teamId, "teamId"),
    workspaceId: requiredString(input.workspaceId, "workspaceId"),
    actorUserId:
      typeof input.actorUserId === "string" && input.actorUserId.trim()
        ? input.actorUserId.trim()
        : undefined,
    feature: requiredString(input.feature, "feature"),
    traceId: requiredString(input.traceId, "traceId"),
    spanId: requiredString(input.spanId, "spanId"),
    gatewayConfigId: requiredString(input.gatewayConfigId, "gatewayConfigId"),
    provider: requiredString(input.provider, "provider"),
    providerRequestId: requiredString(
      input.providerRequestId,
      "providerRequestId",
    ),
    originalBillingIdempotencyKey:
      typeof input.originalBillingIdempotencyKey === "string" &&
      input.originalBillingIdempotencyKey.trim()
        ? input.originalBillingIdempotencyKey.trim()
        : undefined,
  };
}

export async function enqueueProviderCostReconciliation(input: {
  observation?: ModelCallObservation;
  teamId: string;
  workspaceId?: string;
  actorUserId?: string;
  feature: string;
  gatewayConfigId: string;
  originalBillingIdempotencyKey?: string;
}) {
  const observation = input.observation;
  const requestId = observation?.identity.providerRequestId;
  if (
    !observation?.traceId ||
    !observation.spanId ||
    !requestId ||
    !input.workspaceId
  ) {
    return null;
  }
  const adapter = getProviderResponseAdapter(observation.identity.provider);
  if (!adapter?.reconcileCost) {
    return null;
  }

  const payload: ProviderCostReconciliationPayload = {
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    feature: input.feature,
    traceId: observation.traceId,
    spanId: observation.spanId,
    gatewayConfigId: input.gatewayConfigId,
    provider: observation.identity.provider,
    providerRequestId: requestId,
    originalBillingIdempotencyKey: input.originalBillingIdempotencyKey,
  };

  return enqueueWithAudit(RECONCILE_PROVIDER_COST_JOB, payload, {
    jobId: `provider-cost-${observation.spanId}`,
    delay: 1_000,
    attempts: 4,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: 500,
    removeOnFail: 500,
  });
}

async function loadReconciliationTarget(
  payload: ProviderCostReconciliationPayload,
) {
  const [generation] = await db
    .select()
    .from(llmGenerations)
    .where(
      and(
        eq(llmGenerations.teamId, payload.teamId),
        eq(llmGenerations.workspaceId, payload.workspaceId),
        eq(llmGenerations.traceId, payload.traceId),
        eq(llmGenerations.spanId, payload.spanId),
      ),
    )
    .limit(1);
  if (!generation) {
    throw new Error("Provider cost reconciliation generation was not found");
  }
  if (generation.providerCostStatus === "settled") {
    return { generation, gateway: null, alreadySettled: true as const };
  }

  const [gateway] = await db
    .select()
    .from(modelGatewayConfigs)
    .where(eq(modelGatewayConfigs.id, payload.gatewayConfigId))
    .limit(1);
  if (!gateway || !gateway.isActive) {
    throw new Error(
      `Provider cost reconciliation gateway '${payload.gatewayConfigId}' is unavailable`,
    );
  }
  return { generation, gateway, alreadySettled: false as const };
}

async function reconcileProviderCost(
  payload: ProviderCostReconciliationPayload,
) {
  const target = await loadReconciliationTarget(payload);
  if (target.alreadySettled) {
    return { status: "settled" as const, replayed: true };
  }
  const adapter = getProviderResponseAdapter(payload.provider);
  if (!adapter?.reconcileCost) {
    throw new Error(
      `Provider '${payload.provider}' does not support cost reconciliation`,
    );
  }
  const apiKey = decryptSecret(
    target.gateway.apiKeyEncrypted,
    config.modelGatewayEncryptionSecret,
  );
  const receipt = await adapter.reconcileCost({
    baseUrl: target.gateway.baseUrl,
    apiKey: apiKey || undefined,
    requestId: payload.providerRequestId,
    fetch: createLlmFetch(llmEndpointPolicy([target.gateway.baseUrl])),
  });

  if (payload.actorUserId && payload.originalBillingIdempotencyKey) {
    await billingService.reconcileModelProviderCost({
      teamId: payload.teamId,
      actorUserId: payload.actorUserId,
      workspaceId: payload.workspaceId,
      feature: payload.feature,
      originalIdempotencyKey: payload.originalBillingIdempotencyKey,
      reconciliationIdempotencyKey: `provider-cost-reconcile:${target.generation.id}:v1`,
      generationId: target.generation.id,
      provider: payload.provider,
      providerRequestId: payload.providerRequestId,
      settledProviderCostUsd: receipt.settledCostUsd,
    });
  }

  await db
    .update(llmGenerations)
    .set({
      resolvedProviderModel:
        receipt.resolvedProviderModel ??
        target.generation.resolvedProviderModel,
      providerCostSettledUsd: receipt.settledCostUsd.toFixed(12),
      providerCostUsd: receipt.settledCostUsd.toFixed(12),
      providerCostSource: "provider_receipt",
      providerCostStatus: "settled",
      costCurrency: receipt.currency,
      providerReceiptJson: receipt.raw,
      costReconciledAt: new Date(),
      normalizationJson: {
        ...((target.generation.normalizationJson ?? {}) as Record<
          string,
          unknown
        >),
        settledCost: "provider_receipt",
      },
    })
    .where(eq(llmGenerations.id, target.generation.id));

  return { status: "settled" as const, replayed: false };
}

export async function processProviderCostReconciliationJob(
  job: Job<Record<string, unknown>>,
) {
  const payload = parsePayload(job.data);
  try {
    return await reconcileProviderCost(payload);
  } catch (error) {
    const attempts =
      typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
    const finalAttempt = job.attemptsMade + 1 >= attempts;
    if (finalAttempt) {
      const failureReason = isBillingError(error)
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
      // The one case this brief targets — settled provider cost exceeds the
      // original placeholder charge and the team can't cover the shortfall —
      // surfaces as a BillingError("CREDITS_EXHAUSTED", ..., { requested,
      // available }) out of ensureCreditsCapacity, where `requested` is the
      // credits shortfall (creditsDifference) usage-service.ts was trying to
      // collect. Other causes (adapter/network failures, etc.) land here too
      // and simply won't have this figure.
      const creditsDifference =
        isBillingError(error) && typeof error.details?.requested === "number"
          ? (error.details.requested as number)
          : null;

      const [updated] = await db
        .update(llmGenerations)
        .set({
          providerCostStatus: "reconcile_failed",
          providerCostReconcileFailureReason: failureReason,
          providerCostReconcileFailedAt: new Date(),
        })
        .where(
          and(
            eq(llmGenerations.teamId, payload.teamId),
            eq(llmGenerations.workspaceId, payload.workspaceId),
            eq(llmGenerations.traceId, payload.traceId),
            eq(llmGenerations.spanId, payload.spanId),
          ),
        )
        .returning({ id: llmGenerations.id });

      // Known, permanent operational gap: a row that lands here is never
      // automatically rescanned or retried, and this job does not attempt any
      // automatic recovery (retrying the charge, or deducting credits on its
      // own) — whether and how to still collect a known-but-uncollected cost
      // is a product/ops decision, not one this reconciliation path should
      // make. This structured log plus the ops alert below exist only so a
      // human can find and act on the row manually; closing that loop is out
      // of scope here.
      logger.error("Provider cost reconciliation permanently failed", {
        teamId: payload.teamId,
        workspaceId: payload.workspaceId,
        generationId: updated?.id ?? null,
        provider: payload.provider,
        providerRequestId: payload.providerRequestId,
        traceId: payload.traceId,
        spanId: payload.spanId,
        creditsDifference,
        reason: failureReason,
      });

      await opsAlertService
        .trigger({
          alertKey: `billing:provider-cost-reconcile-failed:${payload.teamId}:${payload.traceId}:${payload.spanId}`,
          level: "error",
          source: "billing.provider_cost_reconciliation",
          title: "Provider cost reconciliation permanently failed",
          message: failureReason,
          teamId: payload.teamId,
          metadata: {
            generationId: updated?.id ?? null,
            provider: payload.provider,
            providerRequestId: payload.providerRequestId,
            traceId: payload.traceId,
            spanId: payload.spanId,
            creditsDifference,
          },
        })
        .catch((alertError) => {
          logger.error("Failed to emit ops alert for reconciliation failure", {
            teamId: payload.teamId,
            traceId: payload.traceId,
            spanId: payload.spanId,
            error:
              alertError instanceof Error
                ? alertError.message
                : String(alertError),
          });
        });
    }
    logger.warn("Provider cost reconciliation failed", {
      provider: payload.provider,
      providerRequestId: payload.providerRequestId,
      traceId: payload.traceId,
      spanId: payload.spanId,
      attempt: job.attemptsMade + 1,
      attempts,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
