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
  return generation.modelAlias ? null : generation.providerModel ?? null;
}

function generationOperation(generation: Record<string, unknown>) {
  return metadataString(generation, ["observationOperation", "operation"])
    ?? generation.operation;
}

function metadataString(record: Record<string, unknown>, keys: string[]) {
  const metadata = record.metadataJson && typeof record.metadataJson === "object"
    ? record.metadataJson as Record<string, unknown>
    : {};
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function parsePolicyPayload(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function generationName(generation: Record<string, unknown>) {
  return metadataString(generation, ["observationName", "generationName", "name"])
    ?? generation.operation;
}

function environmentValue(record: Record<string, unknown>) {
  return metadataString(record, ["environment", "env"]);
}

function usageDetails(generation: Record<string, unknown>) {
  const usage = generation.usageJson && typeof generation.usageJson === "object"
    ? generation.usageJson as Record<string, unknown>
    : {};
  const promptTokens = generation.inputTokens ?? usage.inputTokens ?? null;
  const completionTokens = generation.outputTokens ?? usage.outputTokens ?? null;
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
) {
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
  const startedAtDate = startedAt instanceof Date ? startedAt : new Date(startedAt);
  if (Number.isNaN(startedAtDate.getTime())) {
    return false;
  }
  const fullPayloadRetentionDays = 30;
  if (Date.now() - startedAtDate.getTime() <= fullPayloadRetentionDays * 24 * 60 * 60 * 1000) {
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

export function presentTraceSummary(trace: Record<string, unknown>) {
  const startedAt = dateValue(trace.startedAt as Date | string | number | null);
  const endedAt = dateValue(trace.endedAt as Date | string | number | null);
  return {
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
    tags: trace.tagsJson,
    metadata: trace.metadataJson,
  };
}

export function presentTrace(trace: Record<string, unknown>, access: LlmObservabilityAccess) {
  const startedAt = trace.startedAt as Date | string | number | null;
  return {
    ...presentTraceSummary(trace),
    input: payload(trace.inputJson, access, startedAt),
    output: payload(trace.outputJson, access, startedAt),
  };
}

export function presentSpan(span: Record<string, unknown>, access: LlmObservabilityAccess) {
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
    input: payload(span.inputJson, access, startedAt),
    output: payload(span.outputJson, access, startedAt),
    metadata: span.metadataJson,
    errorCode: span.errorCode,
    errorMessage: span.errorMessage,
  };
}

export function presentGeneration(
  generation: Record<string, unknown>,
  access: LlmObservabilityAccess,
) {
  const startedAt = generation.startedAt as Date | string | number | null;
  const startTime = dateValue(startedAt);
  const endTime = dateValue(generation.endedAt as Date | string | number | null);
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
    provider: generation.provider,
    providerModel: providerModelValue(generation),
    executionMode: generation.executionMode,
    keySource: generation.keySource,
    routeStrategy: generation.routeStrategy,
    routeDecision: generation.routeDecisionJson,
    modelParameters: generation.modelParametersJson,
    input: payload(generation.inputJson, access, startedAt),
    output: payload(generation.outputJson, access, startedAt),
    outputText: payload(generation.outputText, access, startedAt),
    finishReason: generation.finishReason,
    reasoningText: payload(generation.reasoningText, access, startedAt),
    providerFields: payload(generation.providerFieldsJson, access, startedAt),
    usage: generation.usageJson,
    usageDetails: usage,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    inputTokens: generation.inputTokens,
    outputTokens: generation.outputTokens,
    totalTokens: generation.totalTokens,
    rawCaptureMode: generation.rawCaptureMode,
    providerRequest: payload(generation.providerRequestJson, access, startedAt),
    providerResponse: payload(generation.providerResponseJson, access, startedAt),
    providerRequestHeaders: payload(generation.providerRequestHeadersJson, access, startedAt),
    providerResponseHeaders: payload(generation.providerResponseHeadersJson, access, startedAt),
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
  const startTime = dateValue(generation.startedAt as Date | string | number | null);
  const endTime = dateValue(generation.endedAt as Date | string | number | null);
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
    provider: generation.provider,
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
