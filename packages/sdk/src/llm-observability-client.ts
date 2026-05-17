import { HttpClient } from "./http-client";

function encode(value: string) {
  return encodeURIComponent(value);
}

function withQuery(path: string, input: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function traceDetailQuery(input: LlmTraceDetailInput) {
  return {
    includePayload:
      input.includePayload === undefined ? undefined : String(input.includePayload),
    observationCursor: input.observationCursor,
    observationLimit: input.observationLimit,
    summaryOnly:
      input.summaryOnly === undefined ? undefined : String(input.summaryOnly),
  };
}

export type LlmObservabilityListInput = {
  from?: string;
  to?: string;
  userId?: string;
  threadId?: string;
  messageId?: string;
  feature?: string;
  status?: LlmObservationStatus;
  traceId?: string;
  cursor?: string;
  limit?: number;
};

export type LlmObservationStatus = "running" | "ok" | "error" | "cancelled";

export type LlmGenerationListInput = Omit<LlmObservabilityListInput, "feature"> & {
  operation?: string;
  provider?: string;
};

export type LlmTraceDetailInput = {
  includePayload?: boolean;
  observationCursor?: string;
  observationLimit?: number;
  summaryOnly?: boolean;
};

export type LlmTeamTraceDetailInput = LlmTraceDetailInput & {
  workspaceId: string;
};

export type LlmTraceSummary = {
  id: string;
  traceId: string;
  teamId: string;
  workspaceId: string;
  userId: string | null;
  userDisplayName: string | null;
  threadId: string | null;
  sessionId: string | null;
  messageId: string | null;
  name: string;
  model: string | null;
  observationCount: number | null;
  totalTokens: number | null;
  environment: string | null;
  feature: string | null;
  status: string;
  level: string;
  statusMessage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startTime: string | null;
  endTime: string | null;
  startedAt: string | null;
  endedAt: string | null;
  latencyMs: number | null;
  durationMs: number | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

export type LlmTraceDetail = LlmTraceSummary & {
  input: unknown;
  output: unknown;
  tags: string[];
  metadata: Record<string, unknown>;
};

export type LlmSpanDetail = {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  teamId: string;
  workspaceId: string;
  userId: string | null;
  threadId: string | null;
  messageId: string | null;
  name: string;
  kind: string;
  operation: string;
  status: string;
  level: string;
  statusMessage: string | null;
  startTime: string | null;
  endTime: string | null;
  startedAt: string | null;
  endedAt: string | null;
  latencyMs: number | null;
  durationMs: number | null;
  input: unknown;
  output: unknown;
  metadata: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
};

export type LlmGenerationSummary = {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  teamId: string;
  workspaceId: string;
  userId: string | null;
  threadId: string | null;
  messageId: string | null;
  operation: string;
  gatewayOperation: string;
  name: string;
  type: string;
  model: string | null;
  provider: string | null;
  executionMode: string | null;
  routeStrategy: string | null;
  status: string;
  level: string;
  statusMessage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startTime: string | null;
  endTime: string | null;
  startedAt: string | null;
  endedAt: string | null;
  latencyMs: number | null;
  durationMs: number | null;
  finishReason: string | null;
  usage: Record<string, unknown> | null;
  usageDetails: Record<string, unknown>;
  promptTokens: number | null;
  completionTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  rawCaptureMode: string;
};

export type LlmGenerationDetail = LlmGenerationSummary & {
  modelParameters: Record<string, unknown>;
  input: unknown;
  output: unknown;
  outputText: unknown;
  reasoningText: unknown;
  providerFields: unknown;
  providerRequest: unknown;
  providerResponse: unknown;
  providerRequestHeaders: unknown;
  providerResponseHeaders: unknown;
  providerStatusCode: number | null;
  providerRequestId: string | null;
  rawCaptureError: string | null;
  metadata: Record<string, unknown>;
};

export type LlmListResponse<T> = {
  items: T[];
  nextCursor: string | null;
};

export type LlmTraceDetailResponse = {
  trace: LlmTraceDetail;
  spans: LlmSpanDetail[];
  generations: LlmGenerationDetail[];
  nextObservationCursor?: string | null;
  observationsTruncated?: boolean;
};

export class LlmObservabilityClient {
  constructor(private readonly http: HttpClient) {}

  listWorkspaceTraces(workspaceId: string, input: LlmObservabilityListInput = {}) {
    return this.http.get<LlmListResponse<LlmTraceSummary>>(
      withQuery(`/v1/workspaces/${encode(workspaceId)}/llm/traces`, input),
    );
  }

  listTeamTraces(teamId: string, input: LlmObservabilityListInput = {}) {
    return this.http.get<LlmListResponse<LlmTraceSummary>>(
      withQuery(`/v1/teams/${encode(teamId)}/llm/traces`, input),
    );
  }

  getWorkspaceTrace(
    workspaceId: string,
    traceId: string,
    input: LlmTraceDetailInput = {},
  ) {
    return this.http.get<LlmTraceDetailResponse>(
      withQuery(
        `/v1/workspaces/${encode(workspaceId)}/llm/traces/${encode(traceId)}`,
        traceDetailQuery(input),
      ),
    );
  }

  getTeamTrace(teamId: string, traceId: string, input: LlmTeamTraceDetailInput) {
    return this.http.get<LlmTraceDetailResponse>(
      withQuery(`/v1/teams/${encode(teamId)}/llm/traces/${encode(traceId)}`, {
        ...traceDetailQuery(input),
        workspaceId: input.workspaceId,
      }),
    );
  }

  listWorkspaceGenerations(workspaceId: string, input: LlmGenerationListInput = {}) {
    return this.http.get<LlmListResponse<LlmGenerationSummary>>(
      withQuery(`/v1/workspaces/${encode(workspaceId)}/llm/generations`, input),
    );
  }

  listTeamGenerations(teamId: string, input: LlmGenerationListInput = {}) {
    return this.http.get<LlmListResponse<LlmGenerationSummary>>(
      withQuery(`/v1/teams/${encode(teamId)}/llm/generations`, input),
    );
  }

  getWorkspaceGeneration(workspaceId: string, generationId: string) {
    return this.http.get<LlmGenerationDetail>(
      `/v1/workspaces/${encode(workspaceId)}/llm/generations/${encode(generationId)}`,
    );
  }

  getTeamGeneration(teamId: string, generationId: string, input: { workspaceId: string }) {
    return this.http.get<LlmGenerationDetail>(
      withQuery(`/v1/teams/${encode(teamId)}/llm/generations/${encode(generationId)}`, input),
    );
  }

  getWorkspaceSpan(workspaceId: string, spanId: string, input: { traceId: string }) {
    return this.http.get<LlmSpanDetail>(
      withQuery(`/v1/workspaces/${encode(workspaceId)}/llm/spans/${encode(spanId)}`, input),
    );
  }

  getTeamSpan(teamId: string, spanId: string, input: { workspaceId: string; traceId: string }) {
    return this.http.get<LlmSpanDetail>(
      withQuery(`/v1/teams/${encode(teamId)}/llm/spans/${encode(spanId)}`, input),
    );
  }

}
