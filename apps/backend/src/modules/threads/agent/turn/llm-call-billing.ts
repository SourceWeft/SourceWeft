import type { UsageInfo } from "@sourceweft/model-gateway";
import type { BillingMode } from "@sourceweft/contracts";
import { logger } from "../../../../shared/logger";
import type { ContentBillingPort } from "../../../content/billing-port";
import {
  resolveGatewayObservedIdentity,
  type LlmExecutionConfig,
} from "../../../content/model-gateway-audit";
import { meterBillableModelUsage } from "../../../content/model-billing";
import type { PreparedThreadTurn, MeteredLlmCallTrace } from "../..";
import type { DeepAgentTurnEvent } from "./events";
import type { TurnRuntime } from "./turn-runtime";
import { addUsage } from "./usage";

function hasUsageOrProviderCost(usage: UsageInfo | undefined) {
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

function resolveBillingMode(
  summary: Awaited<ReturnType<ContentBillingPort["getSummary"]>> | null,
): BillingMode {
  return summary?.billingMode ?? "enforced";
}

export type PendingLlmCallUsage = {
  readonly callIndex: number;
  generationId: string;
  spanId?: string | null;
  operation: "chat.stream" | "chat.complete";
  provider?: string | null;
  routeDecision?: Record<string, unknown>;
  latestUsage?: UsageInfo;
  finishReason?: string;
};

export function isTerminalFinishReason(value: string | undefined | null) {
  return typeof value === "string" && value.trim().length > 0;
}

export function observeLlmCallUsage(input: {
  runtime: TurnRuntime;
  usage?: UsageInfo;
  finishReason?: string;
  operation: "chat.stream" | "chat.complete";
  spanId?: string | null;
  generationId?: string | null;
  provider?: string | null;
  routeDecision?: Record<string, unknown>;
}) {
  if (!input.usage && !isTerminalFinishReason(input.finishReason)) {
    return;
  }

  let pending = input.runtime.pendingLlmCallUsage;
  if (!pending) {
    const callIndex = input.runtime.llmCallSequence + 1;
    input.runtime.llmCallSequence = callIndex;
    pending = {
      callIndex,
      generationId:
        input.generationId?.trim() ||
        input.spanId?.trim() ||
        `call-${callIndex}`,
      spanId: input.spanId,
      operation: input.operation,
      provider: input.provider,
      routeDecision: input.routeDecision,
    };
    input.runtime.pendingLlmCallUsage = pending;
  }

  if (input.generationId?.trim()) {
    pending.generationId = input.generationId.trim();
  }
  if (input.spanId !== undefined) {
    pending.spanId = input.spanId;
  }
  if (input.provider !== undefined) {
    pending.provider = input.provider;
  }
  if (input.routeDecision !== undefined) {
    pending.routeDecision = input.routeDecision;
  }
  pending.operation = input.operation;
  if (input.usage) {
    pending.latestUsage = input.usage;
  }
  if (isTerminalFinishReason(input.finishReason)) {
    pending.finishReason = input.finishReason;
  }
}

export async function* flushPendingLlmCallUsage(input: {
  runtime: TurnRuntime;
  billing?: ContentBillingPort;
  prepared?: PreparedThreadTurn;
  llm?: LlmExecutionConfig;
  reason: string;
}): AsyncGenerator<DeepAgentTurnEvent> {
  const pending = input.runtime.pendingLlmCallUsage;
  if (!pending) {
    return;
  }

  input.runtime.pendingLlmCallUsage = null;

  if (!hasUsageOrProviderCost(pending.latestUsage)) {
    return;
  }

  input.runtime.usage = addUsage(input.runtime.usage, pending.latestUsage);

  const prepared = input.prepared;
  if (!input.billing || !prepared) {
    return;
  }

  try {
    const meteredLlmCall = await meterLlmCallUsage({
      billing: input.billing,
      prepared,
      llm: input.llm,
      usage: pending.latestUsage,
      operation: pending.operation,
      callIndex: pending.callIndex,
      spanId: pending.spanId,
      generationId: pending.generationId,
      provider: pending.provider,
      routeDecision: pending.routeDecision,
    });
    if (meteredLlmCall) {
      input.runtime.recordMeteredLlmCall(meteredLlmCall);
      yield {
        type: "billing",
        meteredLlmCall,
      };
    }
  } catch (error) {
    const meteredLlmCall =
      error && typeof error === "object"
        ? (error as { meteredLlmCall?: unknown }).meteredLlmCall
        : null;
    if (meteredLlmCall && typeof meteredLlmCall === "object") {
      const trace = input.runtime.recordMeteredLlmCall(
        meteredLlmCall as MeteredLlmCallTrace,
      );
      yield {
        type: "billing",
        meteredLlmCall: trace,
      };
    }
    logger.warn("Failed to flush pending LLM call usage", {
      reason: input.reason,
      callIndex: pending.callIndex,
      generationId: pending.generationId,
      threadId: prepared.thread.id,
      userMessageId: prepared.userMessage.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function meterLlmCallUsage(input: {
  billing: ContentBillingPort;
  prepared: PreparedThreadTurn;
  llm?: LlmExecutionConfig;
  usage: UsageInfo | undefined;
  operation: "chat.stream" | "chat.complete";
  callIndex: number;
  spanId?: string | null;
  generationId?: string | null;
  provider?: string | null;
  routeDecision?: Record<string, unknown>;
}): Promise<MeteredLlmCallTrace | null> {
  if (!hasUsageOrProviderCost(input.usage)) {
    return null;
  }

  const traceId =
    input.prepared.traceContext?.traceId ?? input.prepared.runTraceId;
  const callHandle =
    input.generationId?.trim() ||
    input.spanId?.trim() ||
    `call-${input.callIndex}`;
  const id = `llm-call:${traceId}:${callHandle}`;
  const idempotencyKey = id;
  const referenceId = `thread:${input.prepared.thread.id}:message:${input.prepared.userMessage.id}:llm-call:${input.callIndex}`;
  const observedIdentity = resolveGatewayObservedIdentity({
    llm: input.llm,
    modelAlias: input.prepared.modelAlias,
    profileAlias: input.prepared.profileAlias,
  });
  const metadata = {
    threadId: input.prepared.thread.id,
    messageId: input.prepared.userMessage.id,
    userMessageId: input.prepared.userMessage.id,
    runId: input.prepared.runTraceId,
    traceId,
    spanId: input.spanId ?? null,
    generationId: input.generationId ?? null,
    llmCallId: id,
    llmCallIndex: input.callIndex,
    operation: input.operation,
    modelAlias: observedIdentity.modelAlias,
    profileAlias: observedIdentity.profileAlias,
    catalogModelAlias: observedIdentity.catalogModelAlias ?? null,
    catalogProfileAlias: observedIdentity.catalogProfileAlias ?? null,
    provider: input.provider ?? input.llm?.providerHint ?? null,
    providerModel: input.llm?.providerModel ?? input.prepared.providerModel,
    usage: input.usage,
    routeDecision: input.routeDecision ?? null,
    baseIdempotencyKey: input.prepared.llmIdempotencyKey,
  };
  let billingMode: BillingMode = "enforced";

  try {
    const summary = await input.billing.getSummary(
      input.prepared.workspace.organizationId,
    );
    billingMode = resolveBillingMode(summary);

    const metered = await meterBillableModelUsage({
      billing: input.billing,
      teamId: input.prepared.workspace.organizationId,
      workspaceId: input.prepared.workspace.id,
      actorUserId: input.prepared.userId,
      feature: "chat",
      operation: input.operation,
      modelKind: "chat",
      gatewayConfigId: input.prepared.chatProfile.gatewayConfigId,
      profileAlias: input.prepared.profileAlias,
      modelAlias: input.prepared.modelAlias,
      referenceId,
      idempotencyKey,
      usage: input.usage,
      llm: input.llm,
      metadata,
    });

    return {
      id,
      operation: input.operation,
      modelKind: "chat",
      modelAlias: observedIdentity.modelAlias,
      profileAlias: observedIdentity.profileAlias,
      gatewayConfigId: input.prepared.chatProfile.gatewayConfigId,
      usage: input.usage,
      billingStatus: metered.billedBy === "skipped" ? "skipped" : "metered",
      consumedCredits: metered.billing.consumedCredits,
      billedBy: metered.billedBy,
      skipReason: metered.skipReason,
      idempotencyKey,
      referenceId,
      providerCostUsd: metered.cost.providerCostUsd,
      costSource: metered.cost.costSource,
      missingPriceComponents: metered.cost.missingPriceComponents,
      pricingSnapshot: metered.cost.pricingSnapshot,
      billing: {
        teamId: metered.billing.teamId,
        availableCredits: metered.billing.availableCredits,
        consumedThisCycle: metered.billing.consumedThisCycle,
        idempotencyReplayed: metered.billing.idempotencyReplayed,
      },
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
    const trace: MeteredLlmCallTrace = {
      id,
      operation: input.operation,
      modelKind: "chat",
      modelAlias: observedIdentity.modelAlias,
      profileAlias: observedIdentity.profileAlias,
      gatewayConfigId: input.prepared.chatProfile.gatewayConfigId,
      usage: input.usage,
      billingStatus: "meter_failed",
      consumedCredits: 0,
      idempotencyKey,
      referenceId,
      error: errorMessage,
      metadata: {
        ...metadata,
        billingMode,
        billingError: errorMessage,
      },
    };

    logger.warn("Failed to meter LLM call usage", {
      teamId: input.prepared.workspace.organizationId,
      workspaceId: input.prepared.workspace.id,
      threadId: input.prepared.thread.id,
      userMessageId: input.prepared.userMessage.id,
      traceId,
      idempotencyKey,
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
