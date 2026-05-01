import type { UsageInfo } from "@sourceweft/model-gateway";
import { createModelGatewayEvent } from "../../shared/model-gateway/observe";

export type LlmThinkingConfig = {
  mode?: "auto" | "off" | "effort";
  enabled?: boolean;
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  includeReasoning?: boolean;
  supportedParameters?: string[];
  supportedEfforts?: Array<"minimal" | "low" | "medium" | "high" | "xhigh">;
};

export type LlmExecutionConfig = {
  profileAlias?: string;
  executionMode?: "GLOBAL" | "BYOK";
  providerHint?: string;
  byok?: {
    provider: string;
    apiKey?: string;
    apiKeyRef?: string;
  };
  thinking?: LlmThinkingConfig;
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
  routeDecision?: Record<string, unknown> | undefined;
}) {
  return {
    executionMode: input.llm?.executionMode ?? "GLOBAL",
    providerHint: input.llm?.providerHint ?? null,
    byokProvider: input.llm?.byok?.provider ?? null,
    thinkingMode: input.llm?.thinking?.mode ?? null,
    thinkingEnabled: input.llm?.thinking?.enabled ?? false,
    thinkingEffort: input.llm?.thinking?.effort ?? null,
    thinkingIncludeReasoning: input.llm?.thinking?.includeReasoning ?? null,
    keySource: resolveByokKeySource(input.llm),
    provider: input.provider ?? null,
    routeStrategy:
      input.routeDecision && typeof input.routeDecision.strategy === "string"
        ? input.routeDecision.strategy
        : null,
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
  profileAlias?: string | null;
  llm?: LlmExecutionConfig;
  provider?: string | null;
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
    modelAlias: input.modelAlias ?? null,
    routeStrategy: gateway.routeStrategy,
    success: input.success,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    latencyMs: input.latencyMs ?? null,
    usage: input.usage,
    providerCostUsd: input.providerCostUsd ?? null,
    attributes: {
      providerHint: gateway.providerHint,
      byokProvider: gateway.byokProvider,
      profileAlias: input.profileAlias ?? null,
      thinkingEnabled: gateway.thinkingEnabled,
      thinkingEffort: gateway.thinkingEffort,
      routeStrategy: gateway.routeStrategy,
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
  profileAlias?: string | null;
  llm?: LlmExecutionConfig;
}) {
  const audit = buildGatewayAuditMetadata({ llm: input.llm });

  return {
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    userId: input.userId ?? null,
    threadId: input.threadId ?? null,
    messageId: input.messageId ?? null,
    feature: input.feature,
    operation: input.operation,
    modelAlias: input.modelAlias ?? null,
    profileAlias: input.profileAlias ?? null,
    executionMode:
      typeof audit.executionMode === "string" ? audit.executionMode : null,
    keySource: typeof audit.keySource === "string" ? audit.keySource : null,
    routeStrategy: audit.routeStrategy,
  } satisfies Record<string, unknown>;
}
