import type { UsageInfo } from "@sourceweft/model-gateway";
import { createModelGatewayEvent } from "../../shared/model-gateway/observe";

export type LlmExecutionConfig = {
  modelAlias?: string;
  executionMode?: "GLOBAL" | "BYOK";
  providerHint?: string;
  byok?: {
    provider: string;
    apiKey?: string;
    apiKeyRef?: string;
  };
};

function resolveByokKeySource(input: LlmExecutionConfig | undefined) {
  if (!input || input.executionMode !== "BYOK") {
    return "global";
  }
  if (input.byok?.apiKeyRef) {
    return "apiKeyRef";
  }
  if (input.byok?.apiKey) {
    return "rawApiKey";
  }
  return "byok";
}

export function buildGatewayAuditMetadata(input: {
  llm?: LlmExecutionConfig;
  provider?: string;
  providerModel?: string;
  routeDecision?: Record<string, unknown> | undefined;
}) {
  return {
    executionMode: input.llm?.executionMode ?? "GLOBAL",
    providerHint: input.llm?.providerHint ?? null,
    byokProvider: input.llm?.byok?.provider ?? null,
    keySource: resolveByokKeySource(input.llm),
    provider: input.provider ?? null,
    providerModel: input.providerModel ?? null,
    routeDecision: input.routeDecision ?? null,
  };
}

export async function recordGatewayOperationEvent(input: {
  teamId: string;
  workspaceId: string;
  userId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  feature: string;
  operation: string;
  modelKind?:
    | "chat"
    | "rerank"
    | "embedding"
    | "asr"
    | "tts"
    | "vision"
    | "video";
  modelAlias?: string | null;
  llm?: LlmExecutionConfig;
  provider?: string | null;
  providerModel?: string | null;
  routeDecision?: Record<string, unknown> | null;
  usage?: UsageInfo;
  providerCostUsd?: number | null;
  traceId?: string;
  success: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  latencyMs?: number | null;
  attributes?: Record<string, unknown>;
}) {
  const gateway = buildGatewayAuditMetadata({
    llm: input.llm,
    provider: input.provider ?? undefined,
    providerModel: input.providerModel ?? undefined,
    routeDecision: input.routeDecision ?? undefined,
  });

  await createModelGatewayEvent({
    traceId: input.traceId,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    threadId: input.threadId,
    messageId: input.messageId,
    feature: input.feature,
    operation: input.operation,
    executionMode:
      typeof gateway.executionMode === "string" ? gateway.executionMode : null,
    keySource: typeof gateway.keySource === "string" ? gateway.keySource : null,
    provider: typeof gateway.provider === "string" ? gateway.provider : null,
    providerModel:
      typeof gateway.providerModel === "string" ? gateway.providerModel : null,
    modelAlias: input.modelAlias ?? null,
    routeStrategy:
      gateway.routeDecision &&
      typeof gateway.routeDecision === "object" &&
      typeof (gateway.routeDecision as Record<string, unknown>).strategy ===
        "string"
        ? ((gateway.routeDecision as Record<string, unknown>)
            .strategy as string)
        : null,
    success: input.success,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    latencyMs: input.latencyMs ?? null,
    usage: input.usage,
    providerCostUsd: input.providerCostUsd ?? null,
    attributes: {
      providerHint: gateway.providerHint,
      byokProvider: gateway.byokProvider,
      routeDecision: gateway.routeDecision,
      modelKind: input.modelKind ?? null,
      billable: input.modelKind === "chat",
      ...(input.attributes ?? {}),
    },
  });
}

export function buildGatewayRequestMetadata(input: {
  teamId: string;
  workspaceId: string;
  userId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  feature: string;
  operation: string;
  modelKind?:
    | "chat"
    | "rerank"
    | "embedding"
    | "asr"
    | "tts"
    | "vision"
    | "video";
  modelAlias?: string | null;
  llm?: LlmExecutionConfig;
}) {
  const audit = buildGatewayAuditMetadata({ llm: input.llm });
  const routeDecision =
    audit.routeDecision && typeof audit.routeDecision === "object"
      ? (audit.routeDecision as Record<string, unknown>)
      : undefined;

  return {
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    userId: input.userId ?? null,
    threadId: input.threadId ?? null,
    messageId: input.messageId ?? null,
    feature: input.feature,
    operation: input.operation,
    modelAlias: input.modelAlias ?? null,
    executionMode:
      typeof audit.executionMode === "string" ? audit.executionMode : null,
    keySource: typeof audit.keySource === "string" ? audit.keySource : null,
    routeStrategy:
      routeDecision && typeof routeDecision.strategy === "string"
        ? routeDecision.strategy
        : null,
  } satisfies Record<string, unknown>;
}
