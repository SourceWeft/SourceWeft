import { normalizeGatewayError } from "../errors";
import type {
  ChatCompleteInput,
  EmbedBatchInput,
  EmbedInput,
  GatewayOperation,
  ObserveGenerationEnd,
  ObserveGenerationError,
  ObserveGenerationStart,
  RequestOptions,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
  RerankInput,
  UsageInfo,
} from "../types";

const DEFAULT_RAW_CAPTURE_MODE = "normalized" as const;

function randomId(length: number): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return output;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractRequestMetadata(
  payload: { metadata?: Record<string, unknown> },
  options?: RequestOptions,
) {
  return {
    ...(payload.metadata ?? {}),
    ...(options?.metadata ?? {}),
  };
}

function resolveTraceId(options?: RequestOptions) {
  const metadataTraceId = options?.metadata?.traceId;
  return options?.traceId ?? (typeof metadataTraceId === "string" ? metadataTraceId : undefined);
}

function resolveParentSpanId(metadata: Record<string, unknown>) {
  return typeof metadata.parentSpanId === "string"
    ? metadata.parentSpanId
    : typeof metadata.parent_span_id === "string"
      ? metadata.parent_span_id
      : undefined;
}

function readMetadataString(metadata: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function resolveModelParameters(payload: ChatCompleteInput | EmbedInput | EmbedBatchInput | RerankInput) {
  return {
    ...("temperature" in payload && payload.temperature !== undefined
      ? { temperature: payload.temperature }
      : {}),
    ...("topP" in payload && payload.topP !== undefined ? { topP: payload.topP } : {}),
    ...("maxTokens" in payload && payload.maxTokens !== undefined
      ? { maxTokens: payload.maxTokens }
      : {}),
    ...("stop" in payload && payload.stop !== undefined ? { stop: payload.stop } : {}),
    ...("toolChoice" in payload && payload.toolChoice !== undefined
      ? { toolChoice: payload.toolChoice }
      : {}),
    ...("responseFormat" in payload && payload.responseFormat !== undefined
      ? { responseFormat: payload.responseFormat }
      : {}),
    ...("structuredOutput" in payload && payload.structuredOutput !== undefined
      ? { structuredOutput: payload.structuredOutput }
      : {}),
    ...("thinking" in payload && payload.thinking !== undefined
      ? { thinking: payload.thinking }
      : {}),
    ...("dimensions" in payload && payload.dimensions !== undefined
      ? { dimensions: payload.dimensions }
      : {}),
    ...("encodingFormat" in payload && payload.encodingFormat !== undefined
      ? { encodingFormat: payload.encodingFormat }
      : {}),
    ...("inputType" in payload && payload.inputType !== undefined
      ? { inputType: payload.inputType }
      : {}),
    ...("topN" in payload && payload.topN !== undefined ? { topN: payload.topN } : {}),
    ...("returnDocuments" in payload && payload.returnDocuments !== undefined
      ? { returnDocuments: payload.returnDocuments }
      : {}),
    ...(payload.extraBody ? { extraBody: payload.extraBody } : {}),
  };
}

function buildInput(operation: GatewayOperation, payload: ChatCompleteInput | EmbedInput | EmbedBatchInput | RerankInput) {
  if (operation === "chat.complete" || operation === "chat.stream") {
    const chat = payload as ChatCompleteInput;
    return {
      model: chat.model,
      messages: chat.messages,
      tools: chat.tools,
      toolChoice: chat.toolChoice,
      stream: operation === "chat.stream" ? true : chat.stream,
      metadata: chat.metadata,
    };
  }

  if (operation === "embeddings.embed") {
    const embed = payload as EmbedInput;
    return {
      model: embed.model,
      text: embed.text,
      inputType: embed.inputType,
      dimensions: embed.dimensions,
      encodingFormat: embed.encodingFormat,
      metadata: embed.metadata,
    };
  }

  if (operation === "embeddings.embedBatch") {
    const batch = payload as EmbedBatchInput;
    return {
      model: batch.model,
      texts: batch.texts,
      inputCount: batch.texts.length,
      inputType: batch.inputType,
      dimensions: batch.dimensions,
      encodingFormat: batch.encodingFormat,
      metadata: batch.metadata,
    };
  }

  const rerank = payload as RerankInput;
  return {
    model: rerank.model,
    query: rerank.query,
    documents: rerank.documents,
    documentCount: rerank.documents.length,
    topN: rerank.topN,
    returnDocuments: rerank.returnDocuments,
    metadata: rerank.metadata,
  };
}

export function createGenerationObservation(input: {
  operation: GatewayOperation;
  payload: ChatCompleteInput | EmbedInput | EmbedBatchInput | RerankInput;
  options?: RequestOptions;
  target: ResolvedRequestTarget;
}) {
  const metadata = extractRequestMetadata(input.payload, input.options);
  const spanId = `gen_${randomId(16)}`;
  const startedAtMs = Date.now();
  const start: ObserveGenerationStart = {
    traceId: resolveTraceId(input.options),
    spanId,
    parentSpanId: resolveParentSpanId(metadata),
    operation: input.operation,
    name: readMetadataString(metadata, ["observationName", "generationName", "name"]),
    startedAt: new Date(startedAtMs).toISOString(),
    modelAlias: input.payload.model,
    provider: input.target.provider,
    providerModel: input.target.providerModel,
    executionMode: input.target.routeDecision.mode,
    routeDecision: input.target.routeDecision,
    modelParameters: resolveModelParameters(input.payload),
    input: buildInput(input.operation, input.payload),
    rawCaptureMode: DEFAULT_RAW_CAPTURE_MODE,
    attributes: metadata,
  };

  return {
    spanId,
    startedAtMs,
    start,
  };
}

export async function emitGenerationStart(
  config: ResolvedModelGatewayConfig,
  event: ObserveGenerationStart,
) {
  await config.observeSink?.onGenerationStart?.(event);
}

export async function emitGenerationEnd(
  config: ResolvedModelGatewayConfig,
  event: ObserveGenerationEnd,
) {
  await config.observeSink?.onGenerationEnd?.(event);
}

export async function emitGenerationError(
  config: ResolvedModelGatewayConfig,
  event: ObserveGenerationError,
) {
  await config.observeSink?.onGenerationError?.(event);
}

export function buildGenerationErrorEvent(input: {
  traceId?: string;
  spanId: string;
  startedAtMs: number;
  error: unknown;
  attributes?: Record<string, unknown>;
}): ObserveGenerationError {
  const normalized = normalizeGatewayError(input.error);
  return {
    traceId: input.traceId,
    spanId: input.spanId,
    endedAt: new Date().toISOString(),
    latencyMs: Date.now() - input.startedAtMs,
    errorCode: normalized.code,
    errorMessage: normalized.message,
    providerStatusCode: normalized.statusCode,
    providerRequestId: normalized.requestId,
    attributes: input.attributes,
  };
}

export function buildUsageOutput(input: {
  usage?: UsageInfo;
  provider?: string;
  providerModel?: string;
  routeDecision?: unknown;
}) {
  return {
    usage: input.usage,
    provider: input.provider,
    providerModel: input.providerModel,
    routeDecision: input.routeDecision,
  };
}

export function toProviderResponse(raw: unknown): Record<string, unknown> | undefined {
  return toRecord(raw);
}
