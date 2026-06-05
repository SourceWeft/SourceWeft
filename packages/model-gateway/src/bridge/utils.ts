import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { getChatAdapter, getEmbeddingsAdapter } from "../adapters/registry";
import type {
  ChatCompleteInput,
  EmbedBatchInput,
  EmbedInput,
  GatewayMessage,
  LangChainChatModelLike,
  LangChainEmbeddingsLike,
  ModelGatewayConfig,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
  RequestOptions,
  ToolBindingOptions,
  ToolCall,
} from "../types";
import { resolveModelGatewayConfig, resolveRequestTarget } from "../config";
import {
  buildGenerationErrorEvent,
  createGenerationObservation,
  emitGenerationEnd,
  emitGenerationError,
  emitGenerationStart,
  toProviderResponse,
} from "../observe/generation";
import {
  extractFinishReason,
  extractReasoning,
  extractResponseMetadata,
  extractUsage,
} from "./chat";
import { normalizeProviderUsage, normalizeUsage } from "../normalize/usage";

export function toLangChainMessages(messages: GatewayMessage[]): BaseMessage[] {
  return messages.map((message) => {
    if (message.role === "system") {
      return new SystemMessage(gatewayContentToText(message.content));
    }
    if (message.role === "assistant") {
      return new AIMessage({
        content: gatewayContentToText(message.content),
        tool_calls: message.toolCalls?.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          args: toolCall.args ?? {},
          type: "tool_call",
        })),
      });
    }
    if (message.role === "tool") {
      return new ToolMessage({
        content: gatewayContentToText(message.content),
        tool_call_id: message.toolCallId ?? "tool_call",
      });
    }
    return new HumanMessage(message.content);
  });
}

function gatewayContentToText(content: GatewayMessage["content"]) {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("\n")
    .trim();
}

export function createChatModel(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: ChatCompleteInput;
  options?: RequestOptions;
}): LangChainChatModelLike {
  const injected = input.config.langchainFactories?.createChatModel?.({
    target: input.target,
    payload: input.payload,
    options: input.options,
    config: input.config,
  });
  const model =
    injected ??
    getChatAdapter(input.target.providerKind).createModel(
      input.target,
      input.payload,
      input.options,
    );

  const boundModel = !input.payload.tools?.length || !model.bindTools
    ? model
    : model.bindTools(
        input.payload.tools,
        resolveBindToolsKwargs({
          toolBindingOptions: input.payload.toolBindingOptions,
          toolChoice: input.payload.toolChoice,
        }),
      ) as LangChainChatModelLike;

  const modelWithDefaultToolBindingOptions =
    createDefaultToolBindingOptionsLangChainChatModel({
      model: boundModel,
      toolBindingOptions: input.payload.toolBindingOptions,
      toolChoice: input.payload.toolChoice,
    });

  return createObservedLangChainChatModel({
    ...input,
    model: modelWithDefaultToolBindingOptions,
  });
}

function toolBindingOptionsToBindToolsKwargs(
  options?: ToolBindingOptions,
): Record<string, unknown> | undefined {
  if (!options) {
    return undefined;
  }
  const { toolChoice, parallelToolCalls, ...rest } = options;
  const kwargs = {
    ...rest,
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(parallelToolCalls !== undefined
      ? { parallel_tool_calls: parallelToolCalls }
      : {}),
  };
  return Object.keys(kwargs).length > 0 ? kwargs : undefined;
}

function resolveBindToolsKwargs(input: {
  kwargs?: Record<string, unknown>;
  toolBindingOptions?: ToolBindingOptions;
  toolChoice?: ChatCompleteInput["toolChoice"];
}) {
  const defaults = toolBindingOptionsToBindToolsKwargs({
    ...(input.toolBindingOptions ?? {}),
    ...(input.toolChoice !== undefined ? { toolChoice: input.toolChoice } : {}),
  });
  const merged = {
    ...(defaults ?? {}),
    ...(input.kwargs ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function createDefaultToolBindingOptionsLangChainChatModel(input: {
  model: LangChainChatModelLike;
  toolBindingOptions?: ToolBindingOptions;
  toolChoice?: ChatCompleteInput["toolChoice"];
}) {
  const defaultKwargs = resolveBindToolsKwargs({
    toolBindingOptions: input.toolBindingOptions,
    toolChoice: input.toolChoice,
  });
  if (!defaultKwargs) {
    return input.model;
  }

  const wrapped = Object.create(input.model) as LangChainChatModelLike;
  wrapped.bindTools = (tools, kwargs) =>
    createDefaultToolBindingOptionsLangChainChatModel({
      model: input.model.bindTools
        ? input.model.bindTools(
            tools,
            resolveBindToolsKwargs({
              kwargs,
              toolBindingOptions: input.toolBindingOptions,
              toolChoice: input.toolChoice,
            }),
          )
        : input.model,
      toolBindingOptions: input.toolBindingOptions,
      toolChoice: input.toolChoice,
    });
  return wrapped;
}

function createObservedLangChainChatModel(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: ChatCompleteInput;
  options?: RequestOptions;
  model: LangChainChatModelLike;
}): LangChainChatModelLike {
  if (!input.config.observeSink || input.options?.suppressLangChainObservation) {
    return input.model;
  }

  const observed = Object.create(input.model) as LangChainChatModelLike;

  observed.getName = () => input.model.getName?.() ?? input.target.providerModel;
  observed.bindTools = (tools, kwargs) => {
    const resolvedKwargs = resolveBindToolsKwargs({
      kwargs,
      toolBindingOptions: input.payload.toolBindingOptions,
      toolChoice: input.payload.toolChoice,
    });
    return createObservedLangChainChatModel({
      ...input,
      payload: {
        ...input.payload,
        tools: normalizeBoundToolsForObservation(tools),
        ...(resolvedKwargs && "tool_choice" in resolvedKwargs
          ? { toolChoice: resolvedKwargs.tool_choice as ChatCompleteInput["toolChoice"] }
          : {}),
      },
      model: input.model.bindTools
        ? input.model.bindTools(tools, resolvedKwargs)
        : input.model,
    });
  };
  observed.invoke = async (messages) => {
      const generation = createGenerationObservation({
        operation: "chat.complete",
        payload: { ...input.payload, messages: normalizeObservedMessages(messages) },
        options: input.options,
        target: input.target,
      });
      await emitGenerationStart(input.config, generation.start);
      try {
        const result = await input.model.invoke(messages);
        const responseMetadata = extractResponseMetadata(result as { response_metadata?: unknown });
        const reasoning = extractReasoning(result as Parameters<typeof extractReasoning>[0]);
        await emitGenerationEnd(input.config, {
          traceId: generation.start.traceId,
          spanId: generation.spanId,
          endedAt: new Date().toISOString(),
          latencyMs: Date.now() - generation.startedAtMs,
          output: {
            finishReason: extractFinishReason(responseMetadata),
            reasoning,
            routeDecision: input.target.routeDecision,
          },
          outputText: typeof (result as { content?: unknown }).content === "string"
            ? (result as { content: string }).content
            : undefined,
          finishReason: extractFinishReason(responseMetadata),
          reasoningText: reasoning,
          providerFields: cloneRecord(responseMetadata),
          usage:
            normalizeProviderUsage(result) ??
            normalizeUsage(extractUsage({
              raw: result,
              usageMetadata: (result as { usage_metadata?: unknown }).usage_metadata,
              responseMetadata,
            })),
          rawCaptureMode: "sdk_metadata",
          providerResponse: toProviderResponse(responseMetadata),
          attributes: generation.start.attributes,
        });
        return result;
      } catch (error) {
        await emitGenerationError(input.config, buildGenerationErrorEvent({
          traceId: generation.start.traceId,
          spanId: generation.spanId,
          startedAtMs: generation.startedAtMs,
          error,
          attributes: generation.start.attributes,
        }));
        throw error;
      }
    };
  observed.stream = async (messages) => {
      const generation = createGenerationObservation({
        operation: "chat.stream",
        payload: { ...input.payload, messages: normalizeObservedMessages(messages), stream: true },
        options: input.options,
        target: input.target,
      });
      await emitGenerationStart(input.config, generation.start);
      const stream = await input.model.stream(messages);
      return observeStream({
        config: input.config,
        generation,
        routeDecision: input.target.routeDecision,
        stream,
      });
    };

  return observed;
}

async function* observeStream(input: {
  config: ResolvedModelGatewayConfig;
  generation: ReturnType<typeof createGenerationObservation>;
  routeDecision: unknown;
  stream: AsyncIterable<unknown>;
}) {
  let completed = false;
  let usage = undefined;
  let finishReason: string | undefined;
  let reasoning: string | undefined;
  let providerFields: Record<string, unknown> | undefined;
  let outputText = "";

  try {
    for await (const chunk of input.stream) {
      const responseMetadata = extractResponseMetadata(chunk as { response_metadata?: unknown });
      usage =
        normalizeProviderUsage(chunk) ??
        normalizeUsage(extractUsage({
          raw: chunk,
          usageMetadata: (chunk as { usage_metadata?: unknown }).usage_metadata,
          responseMetadata,
        })) ??
        usage;
      finishReason = extractFinishReason(responseMetadata) ?? finishReason;
      const nextReasoning = extractReasoning(
        chunk as Parameters<typeof extractReasoning>[0],
      );
      reasoning = appendText(reasoning, nextReasoning);
      providerFields = cloneRecord(responseMetadata) ?? providerFields;
      const content = (chunk as { content?: unknown }).content;
      if (typeof content === "string") outputText += content;
      yield chunk;
    }
    completed = true;
    await emitGenerationEnd(input.config, {
      traceId: input.generation.start.traceId,
      spanId: input.generation.spanId,
      endedAt: new Date().toISOString(),
      latencyMs: Date.now() - input.generation.startedAtMs,
      output: {
        finishReason,
        reasoning,
        routeDecision: input.routeDecision,
      },
      outputText: outputText || undefined,
      finishReason,
      reasoningText: reasoning,
      providerFields,
      usage,
      rawCaptureMode: "sdk_metadata",
      providerResponse: toProviderResponse(providerFields),
      attributes: input.generation.start.attributes,
    });
  } catch (error) {
    if (!completed) {
      await emitGenerationError(input.config, buildGenerationErrorEvent({
        traceId: input.generation.start.traceId,
        spanId: input.generation.spanId,
        startedAtMs: input.generation.startedAtMs,
        error,
        attributes: input.generation.start.attributes,
      }));
    }
    throw error;
  }
}

function normalizeObservedMessages(value: unknown): GatewayMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((message) => {
    const record = message && typeof message === "object" ? message as Record<string, unknown> : {};
    const kwargs = toRecord(record.kwargs) ?? toRecord(record.lc_kwargs);
    const type = typeof record.type === "string" ? record.type : typeof record._getType === "string" ? record._getType : undefined;
    const role = type?.includes("system")
      ? "system"
      : type?.includes("ai") || type?.includes("assistant")
        ? "assistant"
        : type?.includes("tool")
          ? "tool"
          : "user";
    const content = normalizeObservedContent(record.content ?? kwargs?.content);
    const toolCalls = normalizeObservedToolCalls(record, kwargs);
    return compactGatewayMessage({
      role,
      content,
      toolCallId: typeof record.tool_call_id === "string" ? record.tool_call_id : typeof record.toolCallId === "string" ? record.toolCallId : undefined,
      toolCalls,
    });
  });
}

function compactGatewayMessage(message: GatewayMessage): GatewayMessage {
  return Object.fromEntries(
    Object.entries(message).filter(([, value]) => value !== undefined),
  ) as unknown as GatewayMessage;
}

function appendText(current: string | undefined, next: string | undefined) {
  if (!next) {
    return current;
  }
  return current ? `${current}${next}` : next;
}

function cloneRecord<T extends Record<string, unknown> | undefined>(value: T): T {
  return value ? ({ ...value } as T) : value;
}

function toRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeBoundToolsForObservation(tools: unknown[]) {
  return tools.flatMap((tool) => {
    const record = toRecord(tool);
    if (!record) {
      return [];
    }
    return [{ ...record }];
  });
}

function firstArray(...values: unknown[]) {
  return values.find(Array.isArray) as unknown[] | undefined;
}

function readString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeToolCallArgs(raw: unknown): Pick<ToolCall, "args" | "argsJson"> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return { args: raw as Record<string, unknown> };
  }
  if (typeof raw === "string" && raw.length > 0) {
    return { argsJson: raw };
  }
  return {};
}

function normalizeObservedToolCalls(
  record: Record<string, unknown>,
  kwargs: Record<string, unknown> | null,
): ToolCall[] | undefined {
  const additionalKwargs =
    toRecord(record.additional_kwargs) ??
    toRecord(kwargs?.additional_kwargs);
  const rawToolCalls = firstArray(
    record.tool_calls,
    record.toolCalls,
    kwargs?.tool_calls,
    kwargs?.toolCalls,
    additionalKwargs?.tool_calls,
    additionalKwargs?.toolCalls,
  );
  if (!rawToolCalls?.length) {
    return undefined;
  }

  const toolCalls = rawToolCalls.flatMap((rawToolCall) => {
    const toolCall = toRecord(rawToolCall);
    if (!toolCall) {
      return [];
    }
    const fn = toRecord(toolCall.function);
    const name = readString(toolCall.name, fn?.name);
    if (!name) {
      return [];
    }
    return [{
      id: readString(toolCall.id, toolCall.tool_call_id),
      name,
      ...normalizeToolCallArgs(toolCall.args ?? fn?.arguments),
    }];
  });

  return toolCalls.length > 0 ? toolCalls : undefined;
}

function normalizeObservedContent(value: unknown) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const record = toRecord(item);
      return typeof record?.text === "string" ? record.text : typeof item === "string" ? item : JSON.stringify(item);
    }).join("\n");
  }
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

export function createEmbeddingsModel(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: EmbedInput | EmbedBatchInput;
  options?: RequestOptions;
}): LangChainEmbeddingsLike {
  return (
    input.config.langchainFactories?.createEmbeddingsModel?.({
      target: input.target,
      payload: input.payload,
      options: input.options,
      config: input.config,
    }) ??
    getEmbeddingsAdapter(input.target.providerKind).createModel(
      input.target,
      input.payload,
      input.options,
    )
  );
}

export type LangChainModelExecutionConfig = Pick<
  ChatCompleteInput,
  | "executionMode"
  | "profileAlias"
  | "providerHint"
  | "byokModelId"
  | "credentialId"
  | "byok"
  | "metadata"
  | "thinking"
  | "toolChoice"
  | "toolBindingOptions"
>;

/**
 * Create a LangChain-compatible chat model resolved by gateway routing.
 *
 * This resolves alias + execution mode (GLOBAL/BYOK/providerHint) once and returns
 * a model instance compatible with frameworks expecting BaseLanguageModel.
 */
export async function createLangChainChatModel(input: {
  modelAlias: string;
  config: ModelGatewayConfig;
  execution?: LangChainModelExecutionConfig;
}): Promise<BaseLanguageModel> {
  const resolvedConfig = resolveModelGatewayConfig(input.config);
  const payload: ChatCompleteInput = {
    model: input.modelAlias,
    messages: [],
    stream: true,
    executionMode: input.execution?.executionMode,
    profileAlias: input.execution?.profileAlias,
    providerHint: input.execution?.providerHint,
    byokModelId: input.execution?.byokModelId,
    credentialId: input.execution?.credentialId,
    byok: input.execution?.byok,
    metadata: input.execution?.metadata,
    thinking: input.execution?.thinking,
    toolChoice: input.execution?.toolChoice,
    toolBindingOptions: input.execution?.toolBindingOptions,
  };

  const target = await resolveRequestTarget(resolvedConfig, payload);
  const model = createChatModel({
    config: resolvedConfig,
    target,
    payload,
  });

  return model as unknown as BaseLanguageModel;
}

/**
 * @deprecated Use createLangChainChatModel instead.
 */
export async function createChatModelForAgent(
  modelAlias: string,
  config: ModelGatewayConfig,
): Promise<BaseLanguageModel> {
  return createLangChainChatModel({ modelAlias, config });
}
