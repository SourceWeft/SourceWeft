import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { getChatAdapter, getEmbeddingsAdapter } from "../adapters/registry";
import {
  downgradeForcedToolChoiceInKwargs,
  effectiveForcedToolChoiceSupport,
  filterDisabledParams,
  forcedToolChoiceDisabled,
  resolveModelCapabilities,
} from "../model-capabilities";
import { resolveThinkingMode } from "../thinking";
import type {
  ChatCompleteInput,
  EmbedBatchInput,
  EmbedInput,
  GatewayMessage,
  LangChainChatModelLike,
  LangChainEmbeddingsLike,
  ModelGatewayConfig,
  ProviderKind,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
  RequestOptions,
  ToolBindingOptions,
  ToolCall,
} from "../types";
import { resolveModelGatewayConfig, resolveRequestCandidates } from "../config";
import {
  canonicalProviderModel,
  isAdministrativeGatewayCode,
  isFailoverableError,
  ModelGatewayError,
  normalizeGatewayError,
  selectSurfacedFailoverError,
  summarizeTargetErrors,
  type TargetAttemptError,
} from "../errors";
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
import {
  executeStructuredOutput,
  type StructuredOutputMethod,
} from "./structured-output";
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

/** Adapter guarantee lookup that tolerates injected/test provider kinds. */
function adapterGuaranteesThinkingDisable(kind: ProviderKind): boolean {
  try {
    return getChatAdapter(kind).guaranteesThinkingDisable === true;
  } catch {
    return false;
  }
}

/**
 * Whether a forced `tool_choice` may be sent for this request. False when the
 * model disables `tool_choice` (`disabledParams: { tool_choice: null }` — the JS
 * mirror of langchain-python's disabled_params, unconditional), OR when the
 * legacy thinking-aware capability withholds it (`supportsForcedToolChoice`
 * refined by thinking mode). The disabled_params path is what DeepSeek uses.
 */
export function requestForcedToolChoiceSupport(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: ChatCompleteInput;
}): boolean {
  const capabilities = resolveModelCapabilities(
    input.target.providerModel,
    input.config.modelCapabilities,
  );
  return (
    !forcedToolChoiceDisabled(capabilities.disabledParams) &&
    effectiveForcedToolChoiceSupport({
      capabilities,
      thinkingMode: resolveThinkingMode(input.payload.thinking),
      adapterGuaranteesThinkingDisable: adapterGuaranteesThinkingDisable(
        input.target.providerKind,
      ),
    })
  );
}

/** Resolve the model's disabled request params (langchain-python disabled_params). */
function requestDisabledParams(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
}): Record<string, null | readonly unknown[]> | undefined {
  return resolveModelCapabilities(
    input.target.providerModel,
    input.config.modelCapabilities,
  ).disabledParams;
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
        // Strip the model's disabled params (langchain-python disabled_params);
        // then downgrade any remaining forced tool_choice a legacy
        // `supportsForcedToolChoice: false` model still can't take.
        downgradeForcedToolChoiceInKwargs(
          filterDisabledParams(
            resolveBindToolsKwargs({
              toolBindingOptions: input.payload.toolBindingOptions,
              toolChoice: input.payload.toolChoice,
            }),
            requestDisabledParams(input),
          ),
          requestForcedToolChoiceSupport(input),
        ),
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

/**
 * Model entry points the observation shim deliberately does not wrap.
 *
 * langchain@1.5 drives chat models through `bindTools` and
 * `withStructuredOutput` only — it never calls these on the model. They are
 * listed so that an upgrade which starts using one surfaces as a warning
 * instead of silently producing unobserved (and therefore unbilled) calls.
 */
const UNOBSERVED_ENTRY_POINTS = new Set([
  "batch",
  "generate",
  "_generate",
  "pipe",
]);

const warnedUnobservedEntryPoints = new Set<string>();

/** Map LangChain's `withStructuredOutput` method name back to gateway vocabulary. */
function fromLangChainStructuredOutputMethod(
  method: "jsonSchema" | "jsonMode" | "functionCalling" | undefined,
): StructuredOutputMethod | undefined {
  if (method === "jsonSchema") return "json_schema";
  if (method === "jsonMode") return "json_mode";
  if (method === "functionCalling") return "function_calling";
  return undefined;
}

/**
 * Narrow a LangChain runnable-config passed to `withStructuredOutput().invoke`
 * to the gateway {@link RequestOptions} the executor understands (only the abort
 * signal travels through).
 */
function structuredRequestOptions(options: unknown): RequestOptions | undefined {
  const record =
    options && typeof options === "object"
      ? (options as Record<string, unknown>)
      : undefined;
  const signal = record?.signal;
  return signal instanceof AbortSignal ? { signal } : undefined;
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

  const getName = () => input.model.getName?.() ?? input.target.providerModel;

  const bindTools: LangChainChatModelLike["bindTools"] = (tools, kwargs) => {
    // Runtime bind path (e.g. the agent's command-tool-choice middleware forcing
    // a specific tool). Strip the model's disabled params (langchain-python
    // disabled_params), then downgrade a forced tool_choice a legacy
    // `supportsForcedToolChoice: false` model still can't take.
    const resolvedKwargs = downgradeForcedToolChoiceInKwargs(
      filterDisabledParams(
        resolveBindToolsKwargs({
          kwargs,
          toolBindingOptions: input.payload.toolBindingOptions,
          toolChoice: input.payload.toolChoice,
        }),
        requestDisabledParams(input),
      ),
      requestForcedToolChoiceSupport(input),
    );
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

  /**
   * `withStructuredOutput` returns a runnable, not a chat model, so the returned
   * object's `invoke` is wrapped directly. Rather than blindly forwarding to the
   * model's own `withStructuredOutput`, it routes through the SAME
   * {@link executeStructuredOutput} the chat.complete path uses, so a dedicated
   * `model.withStructuredOutput(schema).invoke(messages)` becomes DeepSeek-safe:
   * the JS mirror of langchain-python's `disabled_params`. For a model whose
   * effective capabilities disable a forced `tool_choice` it binds the schema as
   * an *available* tool (drop-forced); otherwise it uses native
   * `withStructuredOutput` with the caller-pinned method, falling back to the
   * capability's method (DeepSeek → function_calling).
   *
   * The executor runs against the raw model (`input.model`, not the proxy) so
   * its internal `bindTools`/`withStructuredOutput` + `invoke` cannot re-enter
   * this shim and emit a second generation. Observation wraps the whole call and
   * bills against the underlying model response (the raw message), while the
   * returned runnable yields langchain `withStructuredOutput` semantics: the
   * parsed object by default, `{ raw, parsed }` when `includeRaw` is set.
   */
  const withStructuredOutput: LangChainChatModelLike["withStructuredOutput"] = (
    schema,
    structuredConfig,
  ) => {
    const capabilities = resolveModelCapabilities(
      input.target.providerModel,
      input.config.modelCapabilities,
    );
    const cfg = (structuredConfig ?? {}) as {
      method?: "jsonSchema" | "jsonMode" | "functionCalling";
      name?: string;
      includeRaw?: boolean;
      strict?: boolean;
    };
    const pinnedMethod = fromLangChainStructuredOutputMethod(cfg.method);
    const name = cfg.name?.trim() ? cfg.name : "extract";
    const includeRaw = cfg.includeRaw === true;
    const strict = cfg.strict;
    return {
      invoke: async (structuredInput, structuredOptions) => {
        let shaped: unknown;
        await observeInvocation(async () => {
          const { parsed, rawMessage } = await executeStructuredOutput({
            model: input.model,
            schema: schema as Record<string, unknown>,
            name,
            messages: structuredInput,
            target: input.target,
            supportsForcedToolChoice: requestForcedToolChoiceSupport(input),
            ...(pinnedMethod !== undefined ? { method: pinnedMethod } : {}),
            ...(capabilities.structuredOutputMethod !== undefined
              ? { fallbackMethod: capabilities.structuredOutputMethod }
              : {}),
            ...(strict !== undefined ? { strict } : {}),
            allowJsonRepair: capabilities.toolCallArgumentJsonRepair,
            ...(structuredRequestOptions(structuredOptions) !== undefined
              ? { options: structuredRequestOptions(structuredOptions) }
              : {}),
            logger: input.config.logger,
          });
          shaped = includeRaw ? { raw: rawMessage, parsed } : parsed;
          // Observe against the raw model response so usage/billing and
          // finish-reason extraction see the real message, not the parsed shape.
          return rawMessage;
        }, structuredInput);
        return shaped;
      },
    };
  };

  async function observeInvocation(
    run: () => Promise<unknown>,
    messages: unknown,
  ): Promise<unknown> {
      const generation = createGenerationObservation({
        operation: "chat.complete",
        payload: { ...input.payload, messages: normalizeObservedMessages(messages) },
        options: input.options,
        target: input.target,
      });
      await emitGenerationStart(input.config, generation.start);
      try {
        const result = await run();
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
  }

  const invoke: LangChainChatModelLike["invoke"] = async (messages, callOptions) =>
    observeInvocation(() => input.model.invoke(messages, callOptions), messages);

  const stream: LangChainChatModelLike["stream"] = async (messages, callOptions) => {
    const generation = createGenerationObservation({
      operation: "chat.stream",
      payload: { ...input.payload, messages: normalizeObservedMessages(messages), stream: true },
      options: input.options,
      target: input.target,
    });
    await emitGenerationStart(input.config, generation.start);
    const underlying = await input.model.stream(messages, callOptions);
    return observeStream({
      config: input.config,
      generation,
      routeDecision: input.target.routeDecision,
      stream: underlying,
    });
  };

  // bindTools is always exposed, even when the underlying model omits it: the
  // handler degrades to returning the unbound model, and callers rely on the
  // observed model (and anything derived from it) advertising bindTools.
  const overrides: Record<string, unknown> = {
    getName,
    invoke,
    stream,
    bindTools,
  };
  // withStructuredOutput, by contrast, has no meaningful degraded form — the
  // handler must call through — so it is only advertised when really available.
  if (typeof input.model.withStructuredOutput === "function") {
    overrides.withStructuredOutput = withStructuredOutput;
  }

  // A Proxy rather than Object.create: property reads fall through to the real
  // model with `this` bound to the real model, so LangChain internals that touch
  // private fields keep working, and methods added by future LangChain versions
  // cannot silently bypass observation unnoticed.
  return new Proxy(input.model, {
    get(target, prop) {
      if (typeof prop === "string") {
        if (prop in overrides) {
          return overrides[prop];
        }
        if (
          UNOBSERVED_ENTRY_POINTS.has(prop) &&
          !warnedUnobservedEntryPoints.has(prop)
        ) {
          warnedUnobservedEntryPoints.add(prop);
          input.config.logger?.warn?.(
            `Model entry point '${prop}' is not observed by the model gateway; its usage will be untracked.`,
            { entryPoint: prop, providerModel: input.target.providerModel },
          );
        }
      }
      // Receiver is the raw model, not the proxy, so `this` inside pass-through
      // methods is the real instance and private-field access keeps working.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as LangChainChatModelLike;
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

  const candidates = await resolveRequestCandidates(resolvedConfig, payload);
  if (candidates.length === 1) {
    const model = createChatModel({
      config: resolvedConfig,
      target: candidates[0]!,
      payload,
    });
    return model as unknown as BaseLanguageModel;
  }

  return createFailoverLangChainChatModel({
    config: resolvedConfig,
    candidates,
    buildModel: (target) =>
      createChatModel({ config: resolvedConfig, target, payload }),
  }) as unknown as BaseLanguageModel;
}

/**
 * LangChain-facing counterpart of `runWithTargetFailover`: one model per
 * candidate target, built lazily, with the same failover policy — move to the
 * next target only on a failoverable error, never after the caller aborted,
 * and for streams only while no chunk has reached the consumer.
 *
 * `bindTools` returns a new facade whose model factory re-applies the binding
 * per candidate, so a fallback model carries the same tools as the one it
 * replaces. Each candidate model keeps its own observation shim, so every
 * attempt — failed or successful — records its own generation.
 */
function createFailoverLangChainChatModel(input: {
  config: ResolvedModelGatewayConfig;
  candidates: ResolvedRequestTarget[];
  buildModel: (target: ResolvedRequestTarget) => LangChainChatModelLike;
}): LangChainChatModelLike {
  const models: LangChainChatModelLike[] = [];
  const getModel = (index: number) =>
    (models[index] ??= input.buildModel(input.candidates[index]!));

  const callerAborted = (options?: Record<string, unknown>) =>
    Boolean(
      (options as { signal?: AbortSignal } | undefined)?.signal?.aborted,
    );

  const logFailover = (
    operation: string,
    index: number,
    error: unknown,
    nextIndex: number,
  ) => {
    const target = input.candidates[index]!;
    input.config.logger.warn?.("model-gateway.failover", {
      operation,
      alias: target.routeDecision.alias,
      failedProvider: target.provider,
      failedProviderModel: target.providerModel,
      errorCode: normalizeGatewayError(error).code,
      nextProvider: input.candidates[nextIndex]?.provider,
      attempt: index + 1,
      candidates: input.candidates.length,
      ...(nextIndex > index + 1
        ? { skippedSameModelCandidates: nextIndex - index - 1 }
        : {}),
    });
  };

  async function runWithFailover<T>(
    operation: string,
    options: Record<string, unknown> | undefined,
    run: (model: LangChainChatModelLike) => Promise<T>,
  ): Promise<T> {
    const attempts: TargetAttemptError[] = [];
    let index = 0;
    while (index < input.candidates.length) {
      const target = input.candidates[index]!;
      try {
        const result = await run(getModel(index));
        input.config.targetHealth.markSuccess(target);
        return result;
      } catch (error) {
        attempts.push({
          provider: target.provider,
          providerModel: target.providerModel,
          error,
        });
        const aborted = callerAborted(options);
        const errorCode = normalizeGatewayError(error).code;
        // STRUCTURED_OUTPUT deliberately does not cool the target down: the
        // channel is healthy, the model/request combination is what failed.
        if (!aborted && isFailoverableError(error)) {
          input.config.targetHealth.markFailure(target);
        }
        if (!aborted && isAdministrativeGatewayCode(errorCode)) {
          input.config.logger.warn?.("model-gateway.target-quota", {
            operation,
            alias: target.routeDecision.alias,
            provider: target.provider,
            providerModel: target.providerModel,
            errorCode,
          });
        }
        if (aborted) {
          throw error;
        }

        // Same-model channels cannot rescue a model-level structured-output
        // failure — skip straight to the next genuinely different model.
        let nextIndex = -1;
        if (isFailoverableError(error)) {
          nextIndex = index + 1;
        } else if (errorCode === "STRUCTURED_OUTPUT") {
          nextIndex = index + 1;
          while (
            nextIndex < input.candidates.length &&
            canonicalProviderModel(
              input.candidates[nextIndex]!.providerModel,
            ) === canonicalProviderModel(target.providerModel)
          ) {
            nextIndex += 1;
          }
        }

        if (nextIndex < 0 || nextIndex >= input.candidates.length) {
          const surfaced = selectSurfacedFailoverError(attempts);
          if (attempts.length > 1) {
            input.config.logger.warn?.("model-gateway.failover-exhausted", {
              operation,
              alias: target.routeDecision.alias,
              surfacedErrorCode: normalizeGatewayError(surfaced).code,
              targetErrors: summarizeTargetErrors(attempts),
            });
          }
          throw surfaced;
        }
        logFailover(operation, index, error, nextIndex);
        index = nextIndex;
      }
    }
    throw selectSurfacedFailoverError(attempts);
  }

  async function* streamWithFailover(
    messages: unknown,
    options?: Record<string, unknown>,
  ): AsyncGenerator<unknown> {
    const attempts: TargetAttemptError[] = [];
    for (let index = 0; index < input.candidates.length; index++) {
      const target = input.candidates[index]!;
      const isLast = index === input.candidates.length - 1;
      let iterator: AsyncIterator<unknown>;
      let first: IteratorResult<unknown>;
      try {
        const stream = await getModel(index).stream(messages, options);
        iterator = stream[Symbol.asyncIterator]();
        // The failover window closes at the first chunk: until it arrives the
        // consumer has seen nothing, so retrying on the next target is
        // invisible. After it, the attempt is committed — a mid-stream failure
        // ends the stream rather than replaying half an answer elsewhere.
        first = await iterator.next();
      } catch (error) {
        attempts.push({
          provider: target.provider,
          providerModel: target.providerModel,
          error,
        });
        const aborted = callerAborted(options);
        const errorCode = normalizeGatewayError(error).code;
        if (!aborted && isFailoverableError(error)) {
          input.config.targetHealth.markFailure(target);
        }
        if (!aborted && isAdministrativeGatewayCode(errorCode)) {
          input.config.logger.warn?.("model-gateway.target-quota", {
            operation: "chat.stream",
            alias: target.routeDecision.alias,
            provider: target.provider,
            providerModel: target.providerModel,
            errorCode,
          });
        }
        if (aborted || !isFailoverableError(error)) {
          throw aborted ? error : selectSurfacedFailoverError(attempts);
        }
        if (isLast) {
          const surfaced = selectSurfacedFailoverError(attempts);
          if (attempts.length > 1) {
            input.config.logger.warn?.("model-gateway.failover-exhausted", {
              operation: "chat.stream",
              alias: target.routeDecision.alias,
              surfacedErrorCode: normalizeGatewayError(surfaced).code,
              targetErrors: summarizeTargetErrors(attempts),
            });
          }
          throw surfaced;
        }
        logFailover("chat.stream", index, error, index + 1);
        continue;
      }
      input.config.targetHealth.markSuccess(target);
      if (first.done) {
        return;
      }
      yield first.value;
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          return;
        }
        yield next.value;
      }
    }
  }

  const facade: LangChainChatModelLike = {
    getName: () =>
      getModel(0).getName?.() ?? input.candidates[0]!.providerModel,
    invoke: (messages, options) =>
      runWithFailover("chat.complete", options, (model) =>
        model.invoke(messages, options),
      ),
    stream: async (messages, options) => streamWithFailover(messages, options),
    bindTools: (tools, kwargs) =>
      createFailoverLangChainChatModel({
        ...input,
        buildModel: (target) => {
          const model = input.buildModel(target);
          return model.bindTools ? model.bindTools(tools, kwargs) : model;
        },
      }),
    withStructuredOutput: (schema, config) => ({
      invoke: (structuredInput, options) =>
        runWithFailover("chat.complete", options, (model) => {
          if (typeof model.withStructuredOutput !== "function") {
            throw new ModelGatewayError({
              code: "BAD_REQUEST",
              message:
                `Model for provider '${model.getName?.() ?? "unknown"}' does not support structured output`,
              retryable: false,
            });
          }
          return model
            .withStructuredOutput(schema, config)
            .invoke(structuredInput, options);
        }),
    }),
  };

  // Same pass-through contract as the observation shim: unknown properties
  // fall through to the primary model with `this` bound to the real instance.
  return new Proxy(getModel(0), {
    get(target, prop) {
      if (typeof prop === "string" && prop in facade) {
        // Only advertise withStructuredOutput when the primary model does —
        // mirroring the observation shim's conditional surface.
        if (
          prop !== "withStructuredOutput" ||
          typeof target.withStructuredOutput === "function"
        ) {
          return (facade as unknown as Record<string, unknown>)[prop];
        }
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as LangChainChatModelLike;
}
