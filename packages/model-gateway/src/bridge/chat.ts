import { createHash } from "node:crypto";
import type { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import {
  ModelGatewayError,
  normalizeGatewayError,
  toGatewayErrorData,
} from "../errors";
import { normalizeProviderUsage, normalizeUsage } from "../normalize/usage";
import { createChatModel, toLangChainMessages } from "./utils";
import type {
  ChatCompleteInput,
  ChatCompleteResult,
  ChatStreamEvent,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
  RequestOptions,
  StructuredOutputConfig,
} from "../types";

const STRUCTURED_OUTPUT_PREVIEW_LENGTH = 500;

export function extractResponseMetadata(raw: { response_metadata?: unknown }) {
  return raw.response_metadata && typeof raw.response_metadata === "object"
    ? (raw.response_metadata as Record<string, unknown>)
    : undefined;
}

function extractObjectRecord(
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

function langChainStructuredOutputMethod(
  method: "json_schema" | "json_mode" | "function_calling",
) {
  if (method === "json_schema") return "jsonSchema";
  if (method === "json_mode") return "jsonMode";
  return "functionCalling";
}

function assertStructuredOutputSupported(input: {
  config: StructuredOutputConfig;
  model: ReturnType<typeof createChatModel>;
  target: ResolvedRequestTarget;
}) {
  // Provider-level `supports` declarations proved unreliable in practice (a
  // gateway that declared `json_schema` still rejected it), so we do not gate on
  // them. Only validate the request shape locally, then let the provider be the
  // authority on capability — its error is as clear as anything we could raise.
  if (input.config.schema.type !== "object") {
    throw new ModelGatewayError({
      code: "BAD_REQUEST",
      message: "Structured output schemas must use an object root",
      retryable: false,
    });
  }
  if (!input.config.name.trim()) {
    throw new ModelGatewayError({
      code: "BAD_REQUEST",
      message: "Structured output name is required",
      retryable: false,
    });
  }
  if (typeof input.model.withStructuredOutput !== "function") {
    throw new ModelGatewayError({
      code: "BAD_REQUEST",
      message: `Provider adapter '${input.target.providerKind}' does not support structured output`,
      retryable: false,
      provider: input.target.provider,
    });
  }
}

function responseTextForDiagnostics(rawMessage: unknown) {
  const raw = extractObjectRecord(rawMessage);
  if (!raw) {
    return undefined;
  }
  const content = raw?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const record = extractObjectRecord(part);
      return typeof record?.text === "string"
        ? record.text
        : typeof record?.content === "string"
          ? record.content
          : "";
    })
    .join("");
}

function invalidStructuredOutputError(rawMessage: unknown) {
  const content = responseTextForDiagnostics(rawMessage);
  if (content === undefined) {
    return new ModelGatewayError({
      code: "UPSTREAM",
      message: "Provider returned invalid structured output",
      retryable: true,
      metadata: {
        structuredOutputDiagnostics: {
          contentAvailable: false,
        },
      },
    });
  }
  const contentSha256 = createHash("sha256").update(content).digest("hex");
  const contentPreview = content
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, STRUCTURED_OUTPUT_PREVIEW_LENGTH);
  return new ModelGatewayError({
    code: "UPSTREAM",
    message: `Provider returned invalid structured output (length=${content.length}, sha256=${contentSha256})`,
    retryable: true,
    metadata: {
      structuredOutputDiagnostics: {
        contentLength: content.length,
        contentSha256,
        ...(contentPreview ? { contentPreview } : {}),
      },
    },
  });
}

function isStructuredOutputParseError(error: unknown) {
  return (
    error instanceof SyntaxError ||
    extractObjectRecord(error)?.name === "SyntaxError"
  );
}

function langChainInvokeOptions(options?: RequestOptions) {
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
    const model = createChatModel(input);
    const messages = toLangChainMessages(input.payload.messages);
    let rawMessage: AIMessage;
    let structuredOutput: Record<string, unknown> | undefined;

    if (input.payload.structuredOutput) {
      const config = input.payload.structuredOutput;
      assertStructuredOutputSupported({
        config,
        model,
        target: input.target,
      });
      const schema =
        config.description && typeof config.schema.description !== "string"
          ? { ...config.schema, description: config.description }
          : config.schema;
      // When the caller pins a method, use it; otherwise LangChain selects a
      // default per model. `strict` only applies when a method is pinned.
      const structuredModel = model.withStructuredOutput!(schema, {
        includeRaw: true,
        name: config.name,
        ...(config.method
          ? {
              method: langChainStructuredOutputMethod(config.method),
              ...(config.strict !== undefined ? { strict: config.strict } : {}),
            }
          : {}),
      });
      let structuredResult: unknown;
      try {
        structuredResult = await structuredModel.invoke(
          messages,
          langChainInvokeOptions(input.options),
        );
      } catch (error) {
        if (isStructuredOutputParseError(error)) {
          throw invalidStructuredOutputError(undefined);
        }
        throw error;
      }
      const result = extractObjectRecord(structuredResult);
      rawMessage = result?.raw as AIMessage;
      const parsed = result?.parsed;
      if (
        !rawMessage ||
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw invalidStructuredOutputError(result?.raw);
      }
      structuredOutput = parsed as Record<string, unknown>;
    } else {
      rawMessage = (await model.invoke(
        messages,
        langChainInvokeOptions(input.options),
      )) as AIMessage;
    }
    const responseMetadata = extractResponseMetadata(rawMessage);

    return {
      id: typeof rawMessage.id === "string" ? rawMessage.id : undefined,
      model:
        typeof responseMetadata?.model === "string"
          ? responseMetadata.model
          : input.target.providerModel,
      usage:
        normalizeProviderUsage(rawMessage) ??
        normalizeUsage(
          extractUsage({
            raw: rawMessage,
            usageMetadata: rawMessage.usage_metadata,
            responseMetadata,
          }),
        ),
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

export async function* runBridgeChatStream(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: ChatCompleteInput;
  options?: RequestOptions;
}): AsyncGenerator<ChatStreamEvent> {
  try {
    if (input.payload.structuredOutput) {
      throw new ModelGatewayError({
        code: "BAD_REQUEST",
        message: "Structured output is not supported for chat.stream",
        retryable: false,
      });
    }
    const payload = input.payload.stream
      ? input.payload
      : {
          ...input.payload,
          stream: true,
        };

    const model = createChatModel({
      ...input,
      payload,
    });
    const stream = await model.stream(
      toLangChainMessages(payload.messages),
      langChainInvokeOptions(input.options),
    );
    let usage = undefined;
    let finishReason: string | undefined;
    let reasoning: string | undefined;
    let providerFields: Record<string, unknown> | undefined;

    for await (const chunk of stream as AsyncIterable<AIMessageChunk>) {
      const responseMetadata = extractResponseMetadata(chunk);
      usage =
        normalizeProviderUsage(chunk) ??
        normalizeUsage(
          extractUsage({
            raw: chunk,
            usageMetadata: chunk.usage_metadata,
            responseMetadata,
          }),
        ) ??
        usage;
      finishReason = extractFinishReason(responseMetadata) ?? finishReason;
      reasoning = appendText(reasoning, extractReasoning(chunk));
      providerFields = cloneRecord(responseMetadata) ?? providerFields;

      yield { type: "chunk", chunk };
    }

    yield {
      type: "metadata",
      metadata: {
        usage,
        finishReason,
        reasoning,
        providerFields,
        routeDecision: input.target.routeDecision,
        traceId: input.options?.traceId,
      },
    };
  } catch (error) {
    yield {
      type: "error",
      error: toGatewayErrorData(error),
    };
  }
}
