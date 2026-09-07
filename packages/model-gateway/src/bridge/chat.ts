import { awaitWithSignal } from "../request-options";
import {
  closeStreamIterator,
  openStreamIterator,
  type StreamIterator,
} from "./stream-iterator";
import type { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import {
  ModelGatewayError,
  normalizeGatewayError,
  toGatewayErrorData,
} from "../errors";
import {
  createChatModel,
  requestForcedToolChoiceSupport,
  toLangChainMessages,
} from "./utils";
import { executeStructuredOutput } from "./structured-output";
import { resolveModelCapabilities } from "../model-capabilities";
import { resolveThinkingMode } from "../thinking";
import {
  mergeModelCallObservations,
  normalizeModelCallObservation,
} from "../observation/normalize";
import {
  createProviderResponseCapture,
  runWithProviderResponseCapture,
} from "../observation/response-capture";
import type {
  ChatCompleteInput,
  ChatCompleteResult,
  ChatStreamEvent,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
  RequestOptions,
} from "../types";

export function extractResponseMetadata(raw: { response_metadata?: unknown }) {
  return raw.response_metadata && typeof raw.response_metadata === "object"
    ? (raw.response_metadata as Record<string, unknown>)
    : undefined;
}

export function extractObjectRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cloneRecord<T extends Record<string, unknown> | undefined>(
  value: T,
): T {
  return value ? ({ ...value } as T) : value;
}

export function langChainInvokeOptions(options?: RequestOptions) {
  return options?.signal ? { signal: options.signal } : undefined;
}

function extractRawResponseUsage(value: unknown): unknown {
  const record = extractObjectRecord(value);
  if (!record) {
    return undefined;
  }

  const rawResponse = extractObjectRecord(record.__raw_response);
  if (rawResponse?.usage && typeof rawResponse.usage === "object") {
    return rawResponse.usage;
  }

  const choices = Array.isArray(rawResponse?.choices)
    ? rawResponse.choices
    : [];
  for (const choice of choices) {
    const choiceRecord = extractObjectRecord(choice);
    const message = extractObjectRecord(choiceRecord?.message);
    const messageRawResponse = extractObjectRecord(message?.__raw_response);
    if (
      messageRawResponse?.usage &&
      typeof messageRawResponse.usage === "object"
    ) {
      return messageRawResponse.usage;
    }
  }

  return undefined;
}

export function extractFinishReason(
  responseMetadata: Record<string, unknown> | undefined,
) {
  if (typeof responseMetadata?.finish_reason === "string") {
    return responseMetadata.finish_reason;
  }

  if (typeof responseMetadata?.finishReason === "string") {
    return responseMetadata.finishReason;
  }

  return undefined;
}

export function extractUsage(input: {
  raw?: unknown;
  usageMetadata?: unknown;
  responseMetadata: Record<string, unknown> | undefined;
}) {
  const rawResponseUsage = extractRawResponseUsage(input.raw);
  if (rawResponseUsage) {
    return rawResponseUsage;
  }

  if (input.usageMetadata) {
    return input.usageMetadata;
  }

  const responseMetadata = input.responseMetadata;
  if (!responseMetadata) {
    return undefined;
  }

  if (responseMetadata.usage && typeof responseMetadata.usage === "object") {
    return responseMetadata.usage;
  }

  if (
    responseMetadata.tokenUsage &&
    typeof responseMetadata.tokenUsage === "object"
  ) {
    return responseMetadata.tokenUsage;
  }

  return undefined;
}

function extractReasoningFromRecord(
  responseMetadata: Record<string, unknown> | undefined,
) {
  if (typeof responseMetadata?.reasoning_content === "string") {
    return responseMetadata.reasoning_content;
  }

  if (typeof responseMetadata?.reasoningContent === "string") {
    return responseMetadata.reasoningContent;
  }

  const reasoning = responseMetadata?.reasoning;
  if (typeof reasoning === "string") {
    return reasoning;
  }
  if (
    reasoning &&
    typeof reasoning === "object" &&
    typeof (reasoning as Record<string, unknown>).content === "string"
  ) {
    return (reasoning as Record<string, unknown>).content as string;
  }

  return undefined;
}

function appendText(current: string | undefined, next: string | undefined) {
  if (!next) {
    return current;
  }
  return current ? `${current}${next}` : next;
}

export function extractReasoning(raw: {
  additional_kwargs?: unknown;
  content?: unknown;
  contentBlocks?: unknown;
  content_blocks?: unknown;
  kwargs?: unknown;
  response_metadata?: unknown;
}) {
  const contentBlocks = Array.isArray(raw.contentBlocks)
    ? raw.contentBlocks
    : Array.isArray(raw.content_blocks)
      ? raw.content_blocks
      : null;
  if (contentBlocks) {
    const blockReasoning = contentBlocks
      .flatMap((block) => {
        const record = extractObjectRecord(block);
        if (!record) {
          return [] as string[];
        }
        const type =
          typeof record.type === "string" ? record.type.toLowerCase() : "";
        if (!type.includes("reasoning") && !type.includes("thinking")) {
          return [] as string[];
        }
        const text =
          typeof record.text === "string"
            ? record.text
            : typeof record.content === "string"
              ? record.content
              : typeof record.reasoning === "string"
                ? record.reasoning
                : null;
        return text && text.trim().length > 0 ? [text.trim()] : [];
      })
      .join("\n\n")
      .trim();
    if (blockReasoning.length > 0) {
      return blockReasoning;
    }
  }

  return (
    extractReasoningFromRecord(raw as Record<string, unknown>) ??
    extractReasoningFromRecord(extractObjectRecord(raw.response_metadata)) ??
    extractReasoningFromRecord(extractObjectRecord(raw.additional_kwargs)) ??
    extractReasoningFromRecord(extractObjectRecord(raw.kwargs))
  );
}

export async function runBridgeChatComplete(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: ChatCompleteInput;
  options?: RequestOptions;
}): Promise<ChatCompleteResult> {
  try {
    const payload = input.payload;
    const request = { ...input, payload };
    const model = createChatModel(request);
    const messages = toLangChainMessages(payload.messages);
    const responseCapture = createProviderResponseCapture();
    let rawMessage: AIMessage;
    let structuredOutput: Record<string, unknown> | undefined;

    if (payload.structuredOutput) {
      const config = payload.structuredOutput;
      const schema =
        config.description && typeof config.schema.description !== "string"
          ? { ...config.schema, description: config.description }
          : config.schema;
      const capabilities = resolveModelCapabilities(
        input.target.providerModel,
        input.config.modelCapabilities,
      );
      // The shared executor applies the disabled_params mirror: when a model
      // disables `tool_choice` (DeepSeek) the schema is bound as an available
      // tool; otherwise the native withStructuredOutput path is used.
      // `method`/`strict` come from the caller only (capability plays no part in
      // the dispatch — chat.complete pins no fallback method, preserving its
      // long-standing behavior).
      const executed = await awaitWithSignal(input.options?.signal, () =>
        runWithProviderResponseCapture(responseCapture, () =>
          executeStructuredOutput({
            model,
            schema,
            name: config.name,
            messages,
            target: input.target,
            supportsForcedToolChoice: requestForcedToolChoiceSupport(request),
            ...(config.method !== undefined ? { method: config.method } : {}),
            ...(config.strict !== undefined ? { strict: config.strict } : {}),
            allowJsonRepair: capabilities.toolCallArgumentJsonRepair,
            ...(input.options !== undefined ? { options: input.options } : {}),
            logger: input.config.logger,
          }),
        ),
      );
      rawMessage = executed.rawMessage;
      structuredOutput = executed.parsed;
    } else {
      rawMessage = (await awaitWithSignal(input.options?.signal, () =>
        runWithProviderResponseCapture(responseCapture, () =>
          model.invoke(messages, langChainInvokeOptions(input.options)),
        ),
      )) as AIMessage;
    }
    const responseMetadata = extractResponseMetadata(rawMessage);
    const observation = normalizeModelCallObservation({
      modelAlias: payload.model,
      context: {
        target: input.target,
        modality: "chat",
        rawResponse: rawMessage,
        sdkUsage:
          rawMessage.usage_metadata ??
          extractUsage({
            raw: rawMessage,
            usageMetadata: rawMessage.usage_metadata,
            responseMetadata,
          }),
        responseMetadata,
        responseHeaders: responseCapture.headers,
      },
    });

    return {
      id: typeof rawMessage.id === "string" ? rawMessage.id : undefined,
      model:
        typeof responseMetadata?.model === "string"
          ? responseMetadata.model
          : input.target.providerModel,
      usage: observation.usage,
      observation,
      finishReason: extractFinishReason(responseMetadata),
      reasoning: extractReasoning(rawMessage),
      providerFields: cloneRecord(responseMetadata),
      provider: input.target.provider,
      providerModel: input.target.providerModel,
      routeDecision: input.target.routeDecision,
      traceId: input.options?.traceId,
      ...(structuredOutput ? { structuredOutput } : {}),
      raw: rawMessage,
    };
  } catch (error) {
    throw normalizeGatewayError(error);
  }
}

type ChatStreamMetadata = Extract<
  ChatStreamEvent,
  { type: "metadata" }
>["metadata"];

export async function* runBridgeChatStream(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: ChatCompleteInput;
  options?: RequestOptions;
  onFinalMetadata?: (metadata: ChatStreamMetadata) => void;
}): AsyncGenerator<ChatStreamEvent> {
  const responseCapture = createProviderResponseCapture();
  const metadata: ChatStreamMetadata = {
    routeDecision: input.target.routeDecision,
    traceId: input.options?.traceId,
  };
  let iterator: StreamIterator<AIMessageChunk> | undefined;
  let lastChunk: AIMessageChunk | undefined;
  let failed = false;
  let failure: unknown;
  let drained = false;
  const captureObservation = () => {
    if (!lastChunk && !responseCapture.headers) return;
    const responseMetadata = lastChunk && extractResponseMetadata(lastChunk);
    metadata.observation = mergeModelCallObservations(
      metadata.observation,
      normalizeModelCallObservation({
        modelAlias: input.payload.model,
        context: {
          target: input.target,
          modality: "chat",
          rawResponse: lastChunk,
          sdkUsage:
            lastChunk &&
            extractUsage({
              raw: lastChunk,
              usageMetadata: lastChunk.usage_metadata,
              responseMetadata,
            }),
          responseMetadata,
          responseHeaders: responseCapture.headers,
        },
      }),
    );
    metadata.usage = metadata.observation.usage ?? metadata.usage;
  };
  try {
    if (input.payload.structuredOutput) {
      throw new ModelGatewayError({
        code: "BAD_REQUEST",
        message: "Structured output is not supported for chat.stream",
        retryable: false,
      });
    }
    const payload = { ...input.payload, stream: true };
    const model = createChatModel({ ...input, payload });
    iterator = await openStreamIterator({
      open: (signal) =>
        model.stream(toLangChainMessages(payload.messages), {
          signal,
        }) as Promise<AsyncIterable<AIMessageChunk>>,
      signal: input.options?.signal,
      capture: responseCapture,
      logger: input.config.logger,
    });
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      lastChunk = next.value;
      const responseMetadata = extractResponseMetadata(lastChunk);
      captureObservation();
      metadata.finishReason =
        extractFinishReason(responseMetadata) ?? metadata.finishReason;
      metadata.reasoning = appendText(
        metadata.reasoning,
        extractReasoning(lastChunk),
      );
      metadata.providerFields =
        cloneRecord(responseMetadata) ?? metadata.providerFields;
      yield { type: "chunk", chunk: lastChunk };
    }
    drained = true;
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    // Run return before publishing terminal usage. SDK cleanup can supply
    // response headers and must execute in the same capture scope as next().
    let cleanupFailure: unknown;
    let cleanupFailed = false;
    try {
      await closeStreamIterator(iterator, input.config.logger, failed);
    } catch (error) {
      cleanupFailed = true;
      cleanupFailure = error;
    }
    captureObservation();
    input.onFinalMetadata?.(metadata);
    if (cleanupFailed) {
      // Do not yield another event from an iterator the consumer has returned.
      if (!drained && !failed) throw cleanupFailure;
      failed = true;
      failure = cleanupFailure;
    }
  }
  if (failed) {
    yield { type: "error", error: toGatewayErrorData(failure) };
  } else {
    yield { type: "metadata", metadata };
  }
}
