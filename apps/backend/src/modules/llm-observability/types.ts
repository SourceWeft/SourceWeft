import type { ModelCallObservation } from "@sourceweft/model-gateway";

export type LlmObservationStatus = "running" | "ok" | "error" | "cancelled";

export type LlmSpanKind =
  | "agent"
  | "tool"
  | "retrieval"
  | "vector_search"
  | "bm25"
  | "rerank"
  | "embedding"
  | "generation"
  | "system"
  | "thinking"
  | "http";

export type RawCaptureMode =
  "none" | "normalized" | "sdk_metadata" | "reconstructed" | "provider_wire";

export type AuditPayloadMode = "metadata_only" | "preview" | "full";

export type TraceContext = {
  traceId: string;
  rootSpanId?: string;
  parentSpanId?: string;
  teamId: string;
  workspaceId: string;
  userId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  sessionId?: string | null;
  feature?: string | null;
};

export type WriterOptions = {
  strict?: boolean;
  payloadMode?: AuditPayloadMode;
};

export type StartTraceInput = WriterOptions & {
  traceId?: string;
  teamId: string;
  workspaceId: string;
  userId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  sessionId?: string | null;
  name: string;
  feature?: string | null;
  input?: unknown;
  tags?: string[];
  metadata?: Record<string, unknown>;
  startedAt?: Date;
};

export type EndTraceInput = WriterOptions & {
  traceId: string;
  teamId: string;
  workspaceId: string;
  status: Exclude<LlmObservationStatus, "running">;
  endedAt?: Date;
  latencyMs?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  output?: unknown;
  metadata?: Record<string, unknown>;
};

export type StartSpanInput = WriterOptions &
  TraceContext & {
    spanId?: string;
    parentSpanId?: string | null;
    name: string;
    kind: LlmSpanKind;
    operation: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
    startedAt?: Date;
  };

export type EndSpanInput = WriterOptions & {
  traceId: string;
  teamId: string;
  workspaceId: string;
  spanId: string;
  status: Exclude<LlmObservationStatus, "running">;
  output?: unknown;
  metadata?: Record<string, unknown>;
  errorCode?: string | null;
  errorMessage?: string | null;
  endedAt?: Date;
  latencyMs?: number | null;
};

export type UsageLike = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type StartGenerationInput = WriterOptions &
  TraceContext & {
    spanId?: string;
    parentSpanId?: string | null;
    operation: string;
    modelAlias?: string | null;
    provider?: string | null;
    providerModel?: string | null;
    profileAlias?: string | null;
    gatewayConfigId?: string | null;
    executionMode?: "GLOBAL" | "BYOK" | string | null;
    keySource?: string | null;
    routeStrategy?: string | null;
    routeDecision?: unknown;
    modelParameters?: Record<string, unknown>;
    input?: unknown;
    rawCaptureMode?: RawCaptureMode;
    providerRequest?: unknown;
    providerRequestHeaders?: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
    startedAt?: Date;
  };

export type EndGenerationInput = WriterOptions & {
  traceId: string;
  teamId: string;
  workspaceId: string;
  spanId: string;
  output?: unknown;
  outputText?: string | null;
  finishReason?: string | null;
  reasoningText?: string | null;
  providerFields?: unknown;
  observation?: ModelCallObservation | null;
  usage?: UsageLike | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  providerCostUsd?: number | null;
  providerResponse?: unknown;
  providerResponseHeaders?: Record<string, unknown> | null;
  providerStatusCode?: number | null;
  providerRequestId?: string | null;
  rawCaptureError?: string | null;
  status?: "ok";
  endedAt?: Date;
  latencyMs?: number | null;
  metadata?: Record<string, unknown>;
};

export type RecordGenerationErrorInput = WriterOptions & {
  traceId: string;
  teamId: string;
  workspaceId: string;
  spanId: string;
  error?: unknown;
  errorCode?: string | null;
  errorMessage?: string | null;
  providerResponse?: unknown;
  providerStatusCode?: number | null;
  providerRequestId?: string | null;
  rawCaptureError?: string | null;
  endedAt?: Date;
  latencyMs?: number | null;
  metadata?: Record<string, unknown>;
};

export type RecordAuditAccessInput = WriterOptions & {
  teamId: string;
  workspaceId: string;
  actorUserId?: string | null;
  targetType: string;
  targetId: string;
  action: string;
  metadata?: Record<string, unknown>;
};
