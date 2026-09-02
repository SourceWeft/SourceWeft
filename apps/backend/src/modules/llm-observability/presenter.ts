import { parsePolicyPayload } from "@sourceweft/contracts/llm-observability";
import type { LlmObservabilityAccess } from "./permissions";

const hiddenPermissionPayload = {
  redacted: true,
  reason: "insufficient_permission",
} as const;

const hiddenPolicyPayload = {
  redacted: true,
  reason: "payload_policy",
} as const;

const hiddenRetentionPayload = {
  redacted: true,
  reason: "retention_expired",
} as const;

const excludedPayload = {
  redacted: true,
  reason: "payload_excluded",
} as const;

type DetailPresentationOptions = {
  includePayload?: boolean;
};

function dateValue(value: Date | string | number | null | undefined) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function levelValue(status: unknown) {
  if (status === "error") {
    return "ERROR";
  }
  if (status === "cancelled") {
    return "WARNING";
  }
  return "DEFAULT";
}

function statusMessageValue(record: Record<string, unknown>) {
  return record.errorMessage ?? record.errorCode ?? null;
}

function modelValue(generation: Record<string, unknown>) {
  return generation.modelAlias ?? generation.providerModel ?? null;
}

function providerModelValue(generation: Record<string, unknown>) {
  return generation.modelAlias ? null : (generation.providerModel ?? null);
}

/**
 * Aliased generations hide their routing identity, same rule as
 * `providerModelValue`: the alias is the product-facing model — one name, one
 * price — and which provider/target actually served a given request is an
 * internal placement decision. Now that one alias can fan out to several
 * targets, exposing it would let callers observe (and depend on) per-request
 * routing. Only un-aliased calls (BYOK/direct) show their provider.
 */
function providerValue(generation: Record<string, unknown>) {
  return generation.modelAlias ? null : (generation.provider ?? null);
}

function routeDecisionValue(generation: Record<string, unknown>) {
  return generation.modelAlias ? null : (generation.routeDecisionJson ?? null);
}

const ROUTING_IDENTITY_KEYS = ["provider", "providerModel", "routeDecision"];

/**
 * Gateway endpoints echo provider/providerModel/routeDecision into the output
 * payload (`buildUsageOutput`); scrub those for aliased generations so the
 * payload column cannot leak what the top-level fields above deliberately hide.
 */
function stripRoutingIdentity(
  generation: Record<string, unknown>,
  value: unknown,
) {
  if (
    !generation.modelAlias ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (!ROUTING_IDENTITY_KEYS.some((key) => key in record)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key]) => !ROUTING_IDENTITY_KEYS.includes(key),
    ),
  );
}

function generationOperation(generation: Record<string, unknown>) {
  return (
    metadataString(generation, ["observationOperation", "operation"]) ??
    generation.operation
  );
}

function metadataString(record: Record<string, unknown>, keys: string[]) {
  const metadata =
    record.metadataJson && typeof record.metadataJson === "object"
      ? (record.metadataJson as Record<string, unknown>)
      : {};
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function generationName(generation: Record<string, unknown>) {
  return (
    metadataString(generation, ["observationName", "generationName", "name"]) ??
    generation.operation
  );
}

function environmentValue(record: Record<string, unknown>) {
  return metadataString(record, ["environment", "env"]);
}

function usageDetails(generation: Record<string, unknown>) {
  const usage =
    generation.usageJson && typeof generation.usageJson === "object"
      ? (generation.usageJson as Record<string, unknown>)
      : {};
  const promptTokens = generation.inputTokens ?? usage.inputTokens ?? null;
  const completionTokens =
    generation.outputTokens ?? usage.outputTokens ?? null;
  const totalTokens = generation.totalTokens ?? usage.totalTokens ?? null;
  return {
    ...usage,
    promptTokens,
    completionTokens,
    totalTokens,
    input: promptTokens,
    output: completionTokens,
    total: totalTokens,
    unit: "TOKENS",
  };
}

function payload(
  value: unknown,
  access: LlmObservabilityAccess,
  startedAt?: Date | string | number | null,
  options?: DetailPresentationOptions,
) {
  if (options?.includePayload === false) {
    return excludedPayload;
  }
  if (!access.payloadAccess) {
    return hiddenPermissionPayload;
  }
  const parsed = parsePolicyPayload(value);
  const payloadValue = parsed ?? value;
  if (fullPayloadRetentionExpired(payloadValue, startedAt)) {
    return hiddenRetentionPayload;
  }
  if (payloadPolicyBlocksFullPayload(payloadValue)) {
    return hiddenPolicyPayload;
  }
  return payloadValue;
}

function payloadPolicyBlocksFullPayload(value: unknown) {
  const parsed = parsePolicyPayload(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const mode = (parsed as Record<string, unknown>).mode;
  return mode === "metadata_only";
}

function fullPayloadRetentionExpired(
  value: unknown,
  startedAt: Date | string | number | null | undefined,
) {
  if (!startedAt) {
    return false;
  }
  const startedAtDate =
    startedAt instanceof Date ? startedAt : new Date(startedAt);
  if (Number.isNaN(startedAtDate.getTime())) {
    return false;
  }
  const fullPayloadRetentionDays = 30;
  if (
    Date.now() - startedAtDate.getTime() <=
    fullPayloadRetentionDays * 24 * 60 * 60 * 1000
  ) {
    return false;
  }
  const parsed = parsePolicyPayload(value);
  if (typeof parsed === "string") {
    return true;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  return (parsed as Record<string, unknown>).mode === "full";
}

export function presentTraceSummary(
  trace: Record<string, unknown>,
  options?: { includeMetadata?: boolean },
) {
  const startedAt = dateValue(trace.startedAt as Date | string | number | null);
  const endedAt = dateValue(trace.endedAt as Date | string | number | null);
  const summary = {
    id: trace.id,
    traceId: trace.traceId,
    teamId: trace.teamId,
    workspaceId: trace.workspaceId,
    userId: trace.userId,
    userDisplayName: trace.userDisplayName ?? null,
    threadId: trace.threadId,
    sessionId: trace.sessionId,
    messageId: trace.messageId,
    name: trace.name,
    model: trace.model ?? null,
    observationCount: trace.observationCount ?? null,
    totalTokens: trace.totalTokens ?? null,
    environment: environmentValue(trace),
    feature: trace.feature,
    status: trace.status,
    level: levelValue(trace.status),
    statusMessage: statusMessageValue(trace),
    errorCode: trace.errorCode,
    errorMessage: trace.errorMessage,
    startTime: startedAt,
    endTime: endedAt,
    startedAt,
    endedAt,
    latencyMs: trace.latencyMs,
    durationMs: trace.latencyMs,
  };
  return options?.includeMetadata
    ? {
        ...summary,
        tags: trace.tagsJson,
        metadata: trace.metadataJson,
      }
    : summary;
}

export function presentTrace(
  trace: Record<string, unknown>,
  access: LlmObservabilityAccess,
  options?: DetailPresentationOptions,
) {
  const startedAt = trace.startedAt as Date | string | number | null;
  return {
    ...presentTraceSummary(trace, { includeMetadata: true }),
    input: payload(trace.inputJson, access, startedAt, options),
    output: payload(trace.outputJson, access, startedAt, options),
  };
}

export function presentSpan(
  span: Record<string, unknown>,
  access: LlmObservabilityAccess,
  options?: DetailPresentationOptions,
) {
  const startedAt = span.startedAt as Date | string | number | null;
  const startTime = dateValue(startedAt);
  const endTime = dateValue(span.endedAt as Date | string | number | null);
  return {
    id: span.id,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    teamId: span.teamId,
    workspaceId: span.workspaceId,
    userId: span.userId,
    threadId: span.threadId,
    messageId: span.messageId,
    name: span.name,
    kind: span.kind,
    operation: span.operation,
    status: span.status,
    level: levelValue(span.status),
    statusMessage: statusMessageValue(span),
    startTime,
    endTime,
    startedAt: startTime,
    endedAt: endTime,
    latencyMs: span.latencyMs,
    durationMs: span.latencyMs,
    input: payload(span.inputJson, access, startedAt, options),
    output: payload(span.outputJson, access, startedAt, options),
    metadata: span.metadataJson,
    errorCode: span.errorCode,
    errorMessage: span.errorMessage,
  };
}

export function presentGeneration(
  generation: Record<string, unknown>,
  access: LlmObservabilityAccess,
  options?: DetailPresentationOptions,
) {
  const startedAt = generation.startedAt as Date | string | number | null;
  const startTime = dateValue(startedAt);
  const endTime = dateValue(
    generation.endedAt as Date | string | number | null,
  );
  const usage = usageDetails(generation);
  return {
    id: generation.id,
    traceId: generation.traceId,
    spanId: generation.spanId,
    parentSpanId: generation.parentSpanId,
    teamId: generation.teamId,
    workspaceId: generation.workspaceId,
    userId: generation.userId,
    threadId: generation.threadId,
    messageId: generation.messageId,
    operation: generationOperation(generation),
    gatewayOperation: generation.operation,
    name: generationName(generation),
    type: "generation",
    model: modelValue(generation),
    modelAlias: generation.modelAlias,
    provider: providerValue(generation),
    providerModel: providerModelValue(generation),
    requestedProviderModel: generation.providerModel ?? null,
    resolvedProviderModel: generation.resolvedProviderModel ?? null,
    profileAlias: generation.profileAlias ?? null,
    gatewayConfigId: generation.gatewayConfigId ?? null,
    executionMode: generation.executionMode,
    keySource: generation.keySource,
    routeStrategy: generation.routeStrategy,
    routeDecision: routeDecisionValue(generation),
    modelParameters: generation.modelParametersJson,
    input: payload(generation.inputJson, access, startedAt, options),
    output: stripRoutingIdentity(
      generation,
      payload(generation.outputJson, access, startedAt, options),
    ),
    outputText: payload(generation.outputText, access, startedAt, options),
    finishReason: generation.finishReason,
    reasoningText: payload(
      generation.reasoningText,
      access,
      startedAt,
      options,
    ),
    providerFields: payload(
      generation.providerFieldsJson,
      access,
      startedAt,
      options,
    ),
    usage: generation.usageJson,
    usageDetails: usage,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    inputTokens: generation.inputTokens,
    outputTokens: generation.outputTokens,
    totalTokens: generation.totalTokens,
    reasoningTokens: generation.reasoningTokens ?? null,
    cacheReadTokens: generation.cacheReadTokens ?? null,
    cacheWriteTokens: generation.cacheWriteTokens ?? null,
    cost: {
      inlineUsd: generation.providerCostInlineUsd ?? null,
      settledUsd: generation.providerCostSettledUsd ?? null,
      effectiveUsd: generation.providerCostUsd ?? null,
      source: generation.providerCostSource ?? null,
      status: generation.providerCostStatus ?? null,
      currency: generation.costCurrency ?? null,
      reconciledAt: dateValue(
        generation.costReconciledAt as Date | string | number | null,
      ),
    },
    normalization: generation.normalizationJson ?? null,
    rawCaptureMode: generation.rawCaptureMode,
    providerRequest: payload(
      generation.providerRequestJson,
      access,
      startedAt,
      options,
    ),
    providerResponse: payload(
      generation.providerResponseJson,
      access,
      startedAt,
      options,
    ),
    providerRequestHeaders: payload(
      generation.providerRequestHeadersJson,
      access,
      startedAt,
      options,
    ),
    providerResponseHeaders: payload(
      generation.providerResponseHeadersJson,
      access,
      startedAt,
      options,
    ),
    providerStatusCode: generation.providerStatusCode,
    providerRequestId: generation.providerRequestId,
    rawCaptureError: generation.rawCaptureError,
    status: generation.status,
    level: levelValue(generation.status),
    statusMessage: statusMessageValue(generation),
    errorCode: generation.errorCode,
    errorMessage: generation.errorMessage,
    startTime,
    endTime,
    startedAt: startTime,
    endedAt: endTime,
    latencyMs: generation.latencyMs,
    durationMs: generation.latencyMs,
    metadata: generation.metadataJson,
  };
}

export function presentGenerationSummary(generation: Record<string, unknown>) {
  const startTime = dateValue(
    generation.startedAt as Date | string | number | null,
  );
  const endTime = dateValue(
    generation.endedAt as Date | string | number | null,
  );
  const usage = usageDetails(generation);
  return {
    id: generation.id,
    traceId: generation.traceId,
    spanId: generation.spanId,
    parentSpanId: generation.parentSpanId,
    teamId: generation.teamId,
    workspaceId: generation.workspaceId,
    userId: generation.userId,
    threadId: generation.threadId,
    messageId: generation.messageId,
    operation: generationOperation(generation),
    gatewayOperation: generation.operation,
    name: generationName(generation),
    type: "generation",
    model: modelValue(generation),
    modelAlias: generation.modelAlias,
    provider: providerValue(generation),
    providerModel: providerModelValue(generation),
    status: generation.status,
    level: levelValue(generation.status),
    statusMessage: statusMessageValue(generation),
    errorCode: generation.errorCode,
    errorMessage: generation.errorMessage,
    startTime,
    endTime,
    startedAt: startTime,
    endedAt: endTime,
    latencyMs: generation.latencyMs,
    durationMs: generation.latencyMs,
    finishReason: generation.finishReason,
    usage: generation.usageJson,
    usageDetails: usage,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    inputTokens: generation.inputTokens,
    outputTokens: generation.outputTokens,
    totalTokens: generation.totalTokens,
    rawCaptureMode: generation.rawCaptureMode,
  };
}
