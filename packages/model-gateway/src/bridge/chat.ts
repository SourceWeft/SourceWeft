import { createHash } from "node:crypto";
import { jsonrepair } from "jsonrepair";
import type { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import {
  ModelGatewayError,
  normalizeGatewayError,
  toGatewayErrorData,
} from "../errors";
import { normalizeProviderUsage, normalizeUsage } from "../normalize/usage";
import {
  createChatModel,
  requestForcedToolChoiceSupport,
  toLangChainMessages,
} from "./utils";
import {
  planStructuredOutput,
  resolveModelCapabilities,
} from "../model-capabilities";
import { resolveThinkingMode } from "../thinking";
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

/**
 * Diagnostics that turn "empty structured output" from a mystery into a
 * diagnosis: a `finishReason` of "length" plus a non-zero `reasoningLength`
 * on zero content is the thinking-ate-the-budget signature, and
 * `invalidToolCalls` entries mean the model DID call the schema tool but its
 * arguments failed strict JSON parsing (DeepSeek's unescaped inner quotes).
 */
function structuredOutputResponseDiagnostics(rawMessage: unknown) {
  const record = extractObjectRecord(rawMessage);
  if (!record) {
    return {};
  }
  const responseMetadata = extractResponseMetadata(
    record as { response_metadata?: unknown },
  );
  const finishReason = extractFinishReason(responseMetadata);
  const reasoning = extractReasoning(record as unknown as AIMessage);
  const invalidToolCalls = (
    Array.isArray(record.invalid_tool_calls) ? record.invalid_tool_calls : []
  ).flatMap((call) => {
    const callRecord = extractObjectRecord(call);
    if (!callRecord) {
      return [];
    }
    return [
      {
        name: typeof callRecord.name === "string" ? callRecord.name : undefined,
        argsLength:
          typeof callRecord.args === "string"
            ? callRecord.args.length
            : undefined,
        error:
          typeof callRecord.error === "string"
            ? callRecord.error.slice(0, 200)
            : undefined,
      },
    ];
  });
  return {
    ...(finishReason ? { finishReason } : {}),
    ...(typeof reasoning === "string"
      ? { reasoningLength: reasoning.length }
      : {}),
    ...(invalidToolCalls.length > 0 ? { invalidToolCalls } : {}),
  };
}

type SalvagedStructuredOutput = {
  args: Record<string, unknown>;
  source: "invalid_tool_calls" | "additional_kwargs";
  repaired: boolean;
};

function parsePossiblyBrokenJson(
  text: string,
  allowRepair: boolean,
): { value: unknown; repaired: boolean } | undefined {
  try {
    return { value: JSON.parse(text), repaired: false };
  } catch {
    if (!allowRepair) {
      return undefined;
    }
    try {
      return { value: JSON.parse(jsonrepair(text)), repaired: true };
    } catch {
      return undefined;
    }
  }
}

/**
 * Last-resort recovery of a structured tool call the strict parser rejected.
 *
 * DeepSeek V4 routinely emits tool arguments whose *content* embeds unescaped
 * ASCII double quotes (Chinese copy quoting terms: `没有"表面"`), which is
 * invalid JSON. LangChain's `parseToolCall` does a strict `JSON.parse`, files
 * the whole call under `invalid_tool_calls`, and leaves `tool_calls` empty —
 * the model did its job and the answer was thrown away. This salvages those
 * arguments from `invalid_tool_calls` or the raw wire kwargs.
 *
 * Two distinct rungs, LiteLLM-style:
 * - a plain re-parse (arguments were valid JSON all along, just never lifted
 *   into `tool_calls`) is lossless and runs for every model;
 * - the `jsonrepair` rung actually rewrites model output, so it runs only for
 *   models whose capability declares the quirk (`toolCallArgumentJsonRepair`
 *   in the model DB / deployment config) — a well-behaved model's malformed
 *   output should fail loudly, not be silently patched.
 *
 * Safe by construction either way: every structured caller schema-validates
 * the parsed object downstream (the gateway's own zod parse or the caller's
 * validate/repair loop), so a mis-repair is rejected there rather than
 * propagated.
 */
function salvageStructuredToolCall(input: {
  rawMessage: unknown;
  toolName: string;
  allowJsonRepair: boolean;
}): SalvagedStructuredOutput | undefined {
  const record = extractObjectRecord(input.rawMessage);
  if (!record) {
    return undefined;
  }
  const candidates: Array<{
    argsText: string;
    source: SalvagedStructuredOutput["source"];
  }> = [];
  for (const call of Array.isArray(record.invalid_tool_calls)
    ? record.invalid_tool_calls
    : []) {
    const callRecord = extractObjectRecord(call);
    if (
      callRecord?.name === input.toolName &&
      typeof callRecord.args === "string"
    ) {
      candidates.push({
        argsText: callRecord.args,
        source: "invalid_tool_calls",
      });
    }
  }
  const kwargs = extractObjectRecord(record.additional_kwargs);
  for (const call of Array.isArray(kwargs?.tool_calls)
    ? kwargs.tool_calls
    : []) {
    const fn = extractObjectRecord(extractObjectRecord(call)?.function);
    if (fn?.name === input.toolName && typeof fn.arguments === "string") {
      candidates.push({ argsText: fn.arguments, source: "additional_kwargs" });
    }
  }
  for (const candidate of candidates) {
    const parsed = parsePossiblyBrokenJson(
      candidate.argsText,
      input.allowJsonRepair,
    );
    if (
      parsed &&
      parsed.value &&
      typeof parsed.value === "object" &&
      !Array.isArray(parsed.value)
    ) {
      return {
        args: parsed.value as Record<string, unknown>,
        source: candidate.source,
        repaired: parsed.repaired,
      };
    }
  }
  return undefined;
}

function invalidStructuredOutputError(rawMessage: unknown) {
  const content = responseTextForDiagnostics(rawMessage);
  if (content === undefined) {
    return new ModelGatewayError({
      code: "STRUCTURED_OUTPUT",
      message: "Provider returned invalid structured output",
      retryable: true,
      metadata: {
        structuredOutputDiagnostics: {
          contentAvailable: false,
          ...structuredOutputResponseDiagnostics(rawMessage),
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
    code: "STRUCTURED_OUTPUT",
    message: `Provider returned invalid structured output (length=${content.length}, sha256=${contentSha256})`,
    retryable: true,
    metadata: {
      structuredOutputDiagnostics: {
        contentLength: content.length,
        contentSha256,
        ...(contentPreview ? { contentPreview } : {}),
        ...structuredOutputResponseDiagnostics(rawMessage),
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
  allowJsonRepair: boolean;
  logger?: ResolvedModelGatewayConfig["logger"];
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
    const salvaged = salvageStructuredToolCall({
      rawMessage,
      toolName: input.config.name,
      allowJsonRepair: input.allowJsonRepair,
    });
    if (salvaged) {
      input.logger?.warn?.("model-gateway.structured-output-repaired", {
        toolName: input.config.name,
        provider: input.target.provider,
        providerModel: input.target.providerModel,
        source: salvaged.source,
        repaired: salvaged.repaired,
      });
      return { rawMessage, structuredOutput: salvaged.args };
    }
    throw invalidStructuredOutputError(rawMessage);
  }
  return { rawMessage, structuredOutput: call.args as Record<string, unknown> };
}

/**
 * Structured output on a thinking-by-default model: an unstated thinking mode
 * ("auto") resolves to the provider default, which for such models means the
 * response budget is spent on hidden reasoning before the structured answer —
 * the classic empty-content death of a schema call. A caller that asked for a
 * schema and expressed no thinking preference gets reliability: "auto" is
 * translated to "off". An explicit "effort" request is respected untouched —
 * that caller owns the token-budget consequence.
 */
function adjustPayloadForStructuredOutput(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: ChatCompleteInput;
}): ChatCompleteInput {
  if (!input.payload.structuredOutput) {
    return input.payload;
  }
  const capabilities = resolveModelCapabilities(
    input.target.providerModel,
    input.config.modelCapabilities,
  );
  if (!capabilities.forcedToolChoiceBlockedByThinking) {
    return input.payload;
  }
  if (resolveThinkingMode(input.payload.thinking) !== "auto") {
    return input.payload;
  }
  return {
    ...input.payload,
    thinking: {
      ...input.payload.thinking,
      mode: "off",
      enabled: false,
    },
  };
}

export async function runBridgeChatComplete(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: ChatCompleteInput;
  options?: RequestOptions;
}): Promise<ChatCompleteResult> {
  try {
    const payload = adjustPayloadForStructuredOutput(input);
    const request = { ...input, payload };
    const model = createChatModel(request);
    const messages = toLangChainMessages(payload.messages);
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
      // Resolve the structured-output strategy ahead of execution, so the
      // branch below follows a plan instead of judging inline. Support is the
      // *effective* one: with thinking now off on a hard-disable adapter,
      // DeepSeek V4 regains forced function_calling and the schema tool call
      // is guaranteed rather than merely available.
      const plan = planStructuredOutput({
        method: config.method,
        strict: config.strict,
        supportsForcedToolChoice: requestForcedToolChoiceSupport(request),
      });
      if (plan.strategy === "availableTool") {
        const structured = await invokeStructuredViaAvailableTool({
          model,
          schema,
          config,
          messages,
          target: input.target,
          options: input.options,
          allowJsonRepair: capabilities.toolCallArgumentJsonRepair,
          logger: input.config.logger,
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
          // The strict parser may have discarded a real tool call over
          // invalid JSON in its arguments — salvage before failing.
          const salvaged = rawMessage
            ? salvageStructuredToolCall({
                rawMessage,
                toolName: config.name,
                allowJsonRepair: capabilities.toolCallArgumentJsonRepair,
              })
            : undefined;
          if (!salvaged || !rawMessage) {
            throw invalidStructuredOutputError(result?.raw);
          }
          input.config.logger.warn?.(
            "model-gateway.structured-output-repaired",
            {
              toolName: config.name,
              provider: input.target.provider,
              providerModel: input.target.providerModel,
              source: salvaged.source,
              repaired: salvaged.repaired,
            },
          );
          structuredOutput = salvaged.args;
        } else {
          structuredOutput = parsed as Record<string, unknown>;
        }
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
