import type { UsageInfo } from "@sourceweft/model-gateway";
import { createModelGatewayEvent } from "../../shared/model-gateway/llm-observability-sink";
import { logger } from "../../shared/logger";

export type LlmThinkingConfig = {
  mode?: "auto" | "off" | "effort";
  enabled?: boolean;
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  includeReasoning?: boolean;
  supportedParameters?: string[];
  supportedEfforts?: Array<"minimal" | "low" | "medium" | "high" | "xhigh">;
};

export type LlmExecutionConfig = {
  // Global-only abstract model identity. BYOK requests must not rely on this.
  profileAlias?: string;
  // UI/display compatibility field. Execution should prefer providerModel.
  modelAlias?: string;
  // Real provider model sent upstream for both GLOBAL and BYOK execution.
  providerModel?: string;
  executionMode?: "GLOBAL" | "BYOK";
  providerHint?: string;
  byokModelId?: string;
  credentialId?: string;
  byok?: {
    provider: string;
    providerKind?: string;
    baseUrl?: string;
    apiKey?: string;
    apiKeyRef?: string;
    defaultHeaders?: Record<string, string>;
  };
  thinking?: LlmThinkingConfig;
};

function resolveByokKeySource(input: LlmExecutionConfig | undefined) {
  if (!input || input.executionMode !== "BYOK") {
    return "global";
  }
  if (input.byokModelId || input.credentialId) {
    return "byokCredential";
  }
  return "byok";
}

function normalizeIdentityPart(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function resolveGatewayObservedIdentity(input: {
  llm?: LlmExecutionConfig;
  modelAlias?: string | null;
  profileAlias?: string | null;
}) {
  if (input.llm?.executionMode !== "BYOK") {
    return {
      modelAlias: input.modelAlias ?? null,
      profileAlias: input.profileAlias ?? null,
      catalogModelAlias: undefined,
      catalogProfileAlias: undefined,
    };
  }

  const provider =
    normalizeIdentityPart(input.llm.byok?.provider) ??
    normalizeIdentityPart(input.llm.providerHint) ??
    "byok";
  const model =
    normalizeIdentityPart(input.llm.providerModel) ??
    normalizeIdentityPart(input.llm.modelAlias) ??
    normalizeIdentityPart(input.modelAlias ?? undefined) ??
    "model";
  const observedAlias = `byok:${provider}:${model}`;

  return {
    modelAlias: observedAlias,
    profileAlias: null,
    catalogModelAlias: input.modelAlias ?? null,
    catalogProfileAlias: undefined,
  };
}

function safeErrorSummary(error: unknown) {
  if (error instanceof Error) {
    const maybeCode = (error as { code?: unknown }).code;
    const rawMessage = error.message.split("\n", 1)[0] ?? "";
    const message = rawMessage.startsWith("Failed query:")
      ? "Database write failed"
      : rawMessage.slice(0, 240) || error.name;
    return {
      name: error.name,
      code: typeof maybeCode === "string" ? maybeCode : undefined,
      message,
    };
  }
  return {
    message: String(error).split("\n", 1)[0]?.slice(0, 240) ?? "Unknown error",
  };
}

export function buildGatewayAuditMetadata(input: {
  llm?: LlmExecutionConfig;
  provider?: string;
  routeDecision?: Record<string, unknown> | undefined;
}) {
  const executionMode = input.llm?.executionMode ?? "GLOBAL";
  const isByok = executionMode === "BYOK";
  return {
    executionMode,
    providerHint: input.llm?.providerHint ?? null,
    byokProvider: isByok ? input.llm?.byok?.provider ?? null : null,
    ...(isByok ? { byokModelId: input.llm?.byokModelId ?? null } : {}),
    ...(isByok ? { credentialId: input.llm?.credentialId ?? null } : {}),
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
  const observedIdentity = resolveGatewayObservedIdentity({
    llm: input.llm,
    modelAlias: input.modelAlias,
    profileAlias: input.profileAlias,
  });

  try {
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
        typeof gateway.executionMode === "string"
          ? gateway.executionMode
          : null,
      keySource:
        typeof gateway.keySource === "string" ? gateway.keySource : null,
      provider: typeof gateway.provider === "string" ? gateway.provider : null,
      providerModel: input.llm?.providerModel ?? null,
      modelAlias: observedIdentity.modelAlias,
      routeStrategy: gateway.routeStrategy,
      success: input.success,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      latencyMs: input.latencyMs ?? null,
      usage: input.usage,
      providerCostUsd: input.providerCostUsd ?? null,
      attributes: {
        thinkingEnabled: gateway.thinkingEnabled,
        thinkingEffort: gateway.thinkingEffort,
        ...(observedIdentity.catalogModelAlias
          ? { catalogModelAlias: observedIdentity.catalogModelAlias }
          : {}),
        ...(observedIdentity.catalogProfileAlias
          ? { catalogProfileAlias: observedIdentity.catalogProfileAlias }
          : {}),
        byokModelId: gateway.byokModelId,
        credentialId: gateway.credentialId,
        providerModel: input.llm?.providerModel ?? null,
        modelKind: input.modelKind ?? input.attributes?.modelKind ?? null,
        billable: input.modelKind === "chat",
        ...(input.attributes ?? {}),
      },
    });
  } catch (error) {
    logger.warn("Failed to record model gateway event", {
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      traceId: input.traceId,
      operation: input.operation,
      success: input.success,
      error: safeErrorSummary(error),
    });
  }
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
  parentSpanId?: string | null;
}) {
  const audit = buildGatewayAuditMetadata({ llm: input.llm });
  const observedIdentity = resolveGatewayObservedIdentity({
    llm: input.llm,
    modelAlias: input.modelAlias,
    profileAlias: input.profileAlias,
  });

  return {
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    userId: input.userId ?? null,
    threadId: input.threadId ?? null,
    messageId: input.messageId ?? null,
    feature: input.feature,
    operation: input.operation,
    observationName: input.operation,
    observationOperation: input.operation,
    modelAlias: observedIdentity.modelAlias,
    profileAlias: observedIdentity.profileAlias,
    ...(observedIdentity.catalogModelAlias
      ? { catalogModelAlias: observedIdentity.catalogModelAlias }
      : {}),
    ...(observedIdentity.catalogProfileAlias
      ? { catalogProfileAlias: observedIdentity.catalogProfileAlias }
      : {}),
    byokModelId: audit.byokModelId,
    credentialId: audit.credentialId,
    providerModel: input.llm?.providerModel ?? null,
    modelKind: input.modelKind ?? null,
    parentSpanId: input.parentSpanId ?? null,
    executionMode:
      typeof audit.executionMode === "string" ? audit.executionMode : null,
    keySource: typeof audit.keySource === "string" ? audit.keySource : null,
    routeStrategy: audit.routeStrategy,
  } satisfies Record<string, unknown>;
}
