import { normalizeGatewayError } from "../errors";
import type {
  ChatCompleteInput,
  AsrTranscribeInput,
  EmbedBatchInput,
  EmbedInput,
  GatewayOperation,
  ImageGenerateInput,
  ObserveGenerationEnd,
  ObserveGenerationError,
  ObserveGenerationStart,
  RequestOptions,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
  RerankInput,
  TtsSpeechInput,
  UsageInfo,
} from "../types";

const DEFAULT_RAW_CAPTURE_MODE = "normalized" as const;
const OBSERVE_TEXT_PREVIEW_CHARS = 500;

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

function compactRecord(
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const output = Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
  return Object.keys(output).length > 0 ? output : undefined;
}

function readMetadataValue(
  metadata: Record<string, unknown>,
  ...keys: string[]
) {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function buildObserveAttributes(metadata: Record<string, unknown>) {
  return (
    compactRecord({
      teamId: readMetadataValue(metadata, "teamId", "team_id"),
      workspaceId: readMetadataValue(metadata, "workspaceId", "workspace_id"),
      userId: readMetadataValue(metadata, "userId", "user_id"),
      threadId: readMetadataValue(metadata, "threadId", "thread_id"),
      messageId: readMetadataValue(metadata, "messageId", "message_id"),
      feature: readMetadataValue(metadata, "feature"),
      operation: readMetadataValue(metadata, "operation"),
      observationName: readMetadataValue(metadata, "observationName"),
      observationOperation: readMetadataValue(metadata, "observationOperation"),
      environment: readMetadataValue(metadata, "environment", "env"),
      executionMode: readMetadataValue(metadata, "executionMode"),
      keySource: readMetadataValue(metadata, "keySource"),
      provider: readMetadataValue(metadata, "provider"),
      modelAlias: readMetadataValue(metadata, "modelAlias"),
      byokModelId: readMetadataValue(metadata, "byokModelId"),
      credentialId: readMetadataValue(metadata, "credentialId"),
      providerModel: readMetadataValue(metadata, "providerModel"),
      modelKind: readMetadataValue(metadata, "modelKind"),
      routeStrategy: readMetadataValue(metadata, "routeStrategy"),
    }) ?? {}
  );
}

function buildChatLifecycleAttributes(messages: ChatCompleteInput["messages"]) {
  const lastMessageRole = messages.at(-1)?.role;
  const toolMessageCount = messages.filter(
    (message) => message.role === "tool",
  ).length;
  const assistantToolCallCount = messages.reduce(
    (count, message) => count + (message.toolCalls?.length ?? 0),
    0,
  );
  const generationPhase =
    lastMessageRole === "tool"
      ? "tool_result_response"
      : toolMessageCount > 0
        ? "post_tool_context"
        : "initial_response";

  return compactRecord({
    generationPhase,
    messageCount: messages.length,
    lastMessageRole,
    toolMessageCount: toolMessageCount > 0 ? toolMessageCount : undefined,
    assistantToolCallCount:
      assistantToolCallCount > 0 ? assistantToolCallCount : undefined,
  }) ?? {};
}

function buildLifecycleAttributes(
  operation: GatewayOperation,
  payload: ChatCompleteInput | EmbedInput | EmbedBatchInput | RerankInput | AsrTranscribeInput | TtsSpeechInput | ImageGenerateInput,
) {
  if (operation !== "chat.complete" && operation !== "chat.stream") {
    return {};
  }
  return buildChatLifecycleAttributes((payload as ChatCompleteInput).messages);
}

function resolveTraceId(
  metadata: Record<string, unknown>,
  options?: RequestOptions,
) {
  const metadataTraceId = metadata.traceId ?? metadata.trace_id;
  return (
    options?.traceId ??
    (typeof metadataTraceId === "string" ? metadataTraceId : undefined)
  );
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

function textSummary(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const text = value
      .map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return "";
        }
        const record = item as Record<string, unknown>;
        return record.type === "text" && typeof record.text === "string"
          ? record.text
          : record.type === "image_url"
            ? "[image]"
            : "";
      })
      .filter(Boolean)
      .join("\n");
    return {
      length: text.length,
      preview: text.slice(0, OBSERVE_TEXT_PREVIEW_CHARS),
      truncated: text.length > OBSERVE_TEXT_PREVIEW_CHARS,
      contentPartCount: value.length,
    };
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return {
    length: value.length,
    preview: value.slice(0, OBSERVE_TEXT_PREVIEW_CHARS),
    truncated: value.length > OBSERVE_TEXT_PREVIEW_CHARS,
  };
}

function textArraySummary(values: unknown[]) {
  return {
    count: values.length,
    totalLength: values.reduce<number>(
      (sum, value) => sum + (typeof value === "string" ? value.length : 0),
      0,
    ),
    previews: values
      .slice(0, 5)
      .map((value) =>
        typeof value === "string"
          ? textSummary(value)
          : { type: Array.isArray(value) ? "array" : typeof value },
      ),
    truncated: values.length > 5,
  };
}

function summarizeToolCalls(
  toolCalls: { id?: string; name: string }[] | undefined,
) {
  if (!toolCalls?.length) {
    return undefined;
  }
  return toolCalls.map((toolCall) =>
    compactRecord({
      id: toolCall.id,
      name: toolCall.name,
    }),
  );
}

function readToolName(tool: Record<string, unknown>) {
  if (typeof tool.name === "string" && tool.name.length > 0) {
    return tool.name;
  }
  const functionRecord = toRecord(tool.function);
  return typeof functionRecord?.name === "string" && functionRecord.name.length > 0
    ? functionRecord.name
    : undefined;
}

function summarizeToolNames(tools: ChatCompleteInput["tools"]) {
  const names = tools?.map(readToolName).filter((name): name is string => Boolean(name));
  return names?.length ? names : undefined;
}

function resolveModelParameters(
  payload: ChatCompleteInput | EmbedInput | EmbedBatchInput | RerankInput | AsrTranscribeInput | TtsSpeechInput | ImageGenerateInput,
) {
  return compactRecord({
    ...("temperature" in payload && payload.temperature !== undefined
      ? { temperature: payload.temperature }
      : {}),
    ...("topP" in payload && payload.topP !== undefined
      ? { topP: payload.topP }
      : {}),
    ...("maxTokens" in payload && payload.maxTokens !== undefined
      ? { maxTokens: payload.maxTokens }
      : {}),
    ...("stop" in payload && payload.stop !== undefined
      ? { stop: payload.stop }
      : {}),
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
    ...("topN" in payload && payload.topN !== undefined
      ? { topN: payload.topN }
      : {}),
    ...("returnDocuments" in payload && payload.returnDocuments !== undefined
      ? { returnDocuments: payload.returnDocuments }
      : {}),
    ...("language" in payload && payload.language !== undefined
      ? { language: payload.language }
      : {}),
    ...("prompt" in payload && payload.prompt !== undefined
      ? { prompt: textSummary(payload.prompt) }
      : {}),
    ...("responseFormat" in payload && payload.responseFormat !== undefined
      ? { responseFormat: payload.responseFormat }
      : {}),
    ...("timestampGranularities" in payload && payload.timestampGranularities !== undefined
      ? { timestampGranularities: payload.timestampGranularities }
      : {}),
    ...("voice" in payload && payload.voice !== undefined
      ? { voice: payload.voice }
      : {}),
    ...("instructions" in payload && payload.instructions !== undefined
      ? { instructions: textSummary(payload.instructions) }
      : {}),
    ...("speed" in payload && payload.speed !== undefined
      ? { speed: payload.speed }
      : {}),
    ...("aspectRatio" in payload && payload.aspectRatio !== undefined
      ? { aspectRatio: payload.aspectRatio }
      : {}),
    ...("quality" in payload && payload.quality !== undefined
      ? { quality: payload.quality }
      : {}),
    ...("style" in payload && payload.style !== undefined
      ? { style: payload.style }
      : {}),
    ...("count" in payload && payload.count !== undefined
      ? { count: payload.count }
      : {}),
  });
}

function buildInput(
  operation: GatewayOperation,
  payload: ChatCompleteInput | EmbedInput | EmbedBatchInput | RerankInput | AsrTranscribeInput | TtsSpeechInput | ImageGenerateInput,
) {
  if (operation === "chat.complete" || operation === "chat.stream") {
    const chat = payload as ChatCompleteInput;
    return compactRecord({
      messageCount: chat.messages.length,
      messages: chat.messages.map((message) =>
        compactRecord({
          role: message.role,
          content: textSummary(message.content),
          toolCallId: message.toolCallId,
          toolCallCount: message.toolCalls?.length ?? 0,
          toolCalls: summarizeToolCalls(message.toolCalls),
        }),
      ),
      toolCount: chat.tools?.length ?? 0,
      tools: summarizeToolNames(chat.tools),
      toolChoice: chat.toolChoice,
      stream: operation === "chat.stream" ? true : chat.stream,
    }) ?? {};
  }

  if (operation === "embeddings.embed") {
    const embed = payload as EmbedInput;
    return {
      text: textSummary(embed.text),
      inputType: embed.inputType,
      dimensions: embed.dimensions,
      encodingFormat: embed.encodingFormat,
    };
  }

  if (operation === "embeddings.embedBatch") {
    const batch = payload as EmbedBatchInput;
    return {
      texts: textArraySummary(batch.texts),
      inputCount: batch.texts.length,
      inputType: batch.inputType,
      dimensions: batch.dimensions,
      encodingFormat: batch.encodingFormat,
    };
  }

  if (operation === "asr.transcribe") {
    const asr = payload as AsrTranscribeInput;
    return {
      fileName: asr.fileName,
      mimeType: asr.mimeType,
      audioBytes:
        asr.audio instanceof Blob
          ? asr.audio.size
          : asr.audio instanceof ArrayBuffer
            ? asr.audio.byteLength
            : asr.audio.byteLength,
    };
  }

  if (operation === "images.generate") {
    const image = payload as ImageGenerateInput;
    return {
      prompt: textSummary(image.prompt),
      negativePrompt: textSummary(image.negativePrompt),
      aspectRatio: image.aspectRatio,
      quality: image.quality,
      style: image.style,
      count: image.count,
      responseFormat: image.responseFormat,
    };
  }

  if (operation === "tts.speech") {
    const tts = payload as TtsSpeechInput;
    return {
      input: textSummary(tts.input),
      voice: tts.voice,
      responseFormat: tts.responseFormat,
      speed: tts.speed,
      hasInstructions: typeof tts.instructions === "string" && tts.instructions.length > 0,
    };
  }

  const rerank = payload as RerankInput;
  return {
    query: textSummary(rerank.query),
    documents: textArraySummary(rerank.documents),
    documentCount: rerank.documents.length,
    topN: rerank.topN,
    returnDocuments: rerank.returnDocuments,
  };
}

export function createGenerationObservation(input: {
  operation: GatewayOperation;
  payload: ChatCompleteInput | EmbedInput | EmbedBatchInput | RerankInput | AsrTranscribeInput | TtsSpeechInput | ImageGenerateInput;
  options?: RequestOptions;
  target: ResolvedRequestTarget;
}) {
  const metadata = extractRequestMetadata(input.payload, input.options);
  const attributes = {
    ...buildObserveAttributes(metadata),
    ...buildLifecycleAttributes(input.operation, input.payload),
  };
  const spanId = `gen_${randomId(16)}`;
  const startedAtMs = Date.now();
  const start: ObserveGenerationStart = {
    traceId: resolveTraceId(metadata, input.options),
    spanId,
    parentSpanId: resolveParentSpanId(metadata),
    operation: input.operation,
    name: readMetadataString(metadata, [
      "observationName",
      "generationName",
      "name",
    ]),
    startedAt: new Date(startedAtMs).toISOString(),
    modelAlias: input.payload.model,
    provider: input.target.provider,
    providerModel: input.target.providerModel,
    executionMode: input.target.routeDecision.mode,
    routeDecision: input.target.routeDecision,
    modelParameters: resolveModelParameters(input.payload),
    input: buildInput(input.operation, input.payload),
    rawCaptureMode: DEFAULT_RAW_CAPTURE_MODE,
    attributes,
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
  try {
    await config.observeSink?.onGenerationStart?.(event);
  } catch (error) {
    config.logger.warn?.("model-gateway.observe.generation_start.failed", {
      operation: event.operation,
      traceId: event.traceId,
      spanId: event.spanId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function emitGenerationEnd(
  config: ResolvedModelGatewayConfig,
  event: ObserveGenerationEnd,
) {
  try {
    await config.observeSink?.onGenerationEnd?.(event);
  } catch (error) {
    config.logger.warn?.("model-gateway.observe.generation_end.failed", {
      traceId: event.traceId,
      spanId: event.spanId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function emitGenerationError(
  config: ResolvedModelGatewayConfig,
  event: ObserveGenerationError,
) {
  try {
    await config.observeSink?.onGenerationError?.(event);
  } catch (error) {
    config.logger.warn?.("model-gateway.observe.generation_error.failed", {
      traceId: event.traceId,
      spanId: event.spanId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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

export function toProviderResponse(
  raw: unknown,
): Record<string, unknown> | undefined {
  return toRecord(raw);
}
