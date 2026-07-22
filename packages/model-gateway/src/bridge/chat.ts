import { createHash } from "node:crypto";
import type { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import {
  ModelGatewayError,
  normalizeGatewayError,
  toGatewayErrorData,
} from "../errors";
import { normalizeProviderUsage, normalizeUsage } from "../normalize/usage";
import { createChatModel, toLangChainMessages } from "./utils";
import {
  planStructuredOutput,
  resolveModelCapabilities,
} from "../model-capabilities";
import type {
  ChatCompleteInput,
  ChatCompleteResult,
  ChatStreamEvent,
  LangChainChatModelLike,
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

/**
 * Structured output by binding the schema as an *available* tool — the strategy
 * {@link planStructuredOutput} selects for models that reject a forced
 * `tool_choice` (e.g. DeepSeek V4, always in thinking mode).
 *
 * This is the JS equivalent of what Python LangChain's
 * `ChatOpenAI.with_structured_output(method="function_calling")` produces once a
 * disabled `tool_choice` is filtered out (`disabled_params`): bind the schema as
 * a single tool with `parallel_tool_calls: false` and *no* `tool_choice` (the
 * API default, auto, applies), then take the first matching tool call — the
 * `JsonOutputKeyToolsParser(key_name=..., first_tool_only=True)` behavior.
 * `@langchain/openai` (JS) ships no `disabled_params`, so the bridge assembles
 * it here. The decision is the planner's; this only executes it. The model may
 * occasionally answer without calling the tool; the caller's repair loop covers
 * that turn.
 */
async function invokeStructuredViaAvailableTool(input: {
  model: LangChainChatModelLike;
  schema: Record<string, unknown>;
  config: StructuredOutputConfig;
  messages: unknown;
  target: ResolvedRequestTarget;
  options?: RequestOptions;
  strict?: boolean;
}): Promise<{ rawMessage: AIMessage; structuredOutput: Record<string, unknown> }> {
  if (typeof input.model.bindTools !== "function") {
    throw new ModelGatewayError({
      code: "BAD_REQUEST",
      message: `Provider adapter '${input.target.providerKind}' cannot bind tools for structured output`,
      retryable: false,
      provider: input.target.provider,
    });
  }
  const tool = {
    type: "function",
    function: {
      name: input.config.name,
      ...(typeof input.schema.description === "string"
        ? { description: input.schema.description }
        : {}),
      parameters: input.schema,
    },
  };
  // No tool_choice (Python filters the forced one out; the API defaults to
  // auto); parallel_tool_calls: false to keep it to a single structured call.
  const bound = input.model.bindTools([tool], {
    parallel_tool_calls: false,
    ...(typeof input.strict === "boolean" ? { strict: input.strict } : {}),
  });
  const rawMessage = (await bound.invoke(
    input.messages,
    langChainInvokeOptions(input.options),
  )) as AIMessage;
  // first_tool_only, keyed by the schema tool name.
  const call = rawMessage.tool_calls?.find(
    (toolCall) => toolCall.name === input.config.name,
  );
  if (
    !call ||
    !call.args ||
    typeof call.args !== "object" ||
    Array.isArray(call.args)
  ) {
    throw invalidStructuredOutputError(rawMessage);
  }
  return { rawMessage, structuredOutput: call.args as Record<string, unknown> };
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
      const schema =
        config.description && typeof config.schema.description !== "string"
          ? { ...config.schema, description: config.description }
          : config.schema;
      // Resolve the structured-output strategy from model capabilities ahead of
      // execution, so the branch below follows a plan instead of judging inline.
      const capabilities = resolveModelCapabilities(
        input.target.providerModel,
        input.config.modelCapabilities,
      );
      const plan = planStructuredOutput({
        method: config.method,
        strict: config.strict,
        supportsForcedToolChoice: capabilities.supportsForcedToolChoice,
      });
      if (plan.strategy === "availableTool") {
        const structured = await invokeStructuredViaAvailableTool({
          model,
          schema,
          config,
          messages,
          target: input.target,
          options: input.options,
          ...(plan.strict !== undefined ? { strict: plan.strict } : {}),
        });
        rawMessage = structured.rawMessage;
        structuredOutput = structured.structuredOutput;
      } else {
        assertStructuredOutputSupported({
          config,
          model,
          target: input.target,
        });
        // `method` undefined lets LangChain select per model; a pinned method is
        // passed through. `strict` only applies alongside a pinned method.
        const structuredModel = model.withStructuredOutput!(schema, {
          includeRaw: true,
          name: config.name,
          ...(plan.method
            ? {
                method: langChainStructuredOutputMethod(plan.method),
                ...(plan.strict !== undefined
                  ? { strict: plan.strict }
                  : {}),
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
      }
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
