import {
  BaseCallbackHandler,
  type HandleLLMNewTokenCallbackFields,
  type NewTokenIndices,
} from "@langchain/core/callbacks/base";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import type { ChatGenerationChunk } from "@langchain/core/outputs";
import { createLangChainChatModel } from "../src/bridge/utils";
import { normalizeGatewayError } from "../src/errors";
import type {
  GatewayLogger,
  LangChainChatModelLike,
  ModelGatewayConfig,
  ObserveGenerationEnd,
  ObserveGenerationError,
  ObserveGenerationStart,
  ProviderKind,
} from "../src/types";

/**
 * Which of core's two internal streaming paths `invoke` takes, decided by a
 * flag on the attached handler:
 * - `llm-new-token`: `lc_prefer_streaming` → `_streamResponseChunks` and
 *   `handleLLMNewToken` per chunk (LangGraph's v1/v2 messages handler).
 * - `chat-model-stream-events`: `lc_prefer_chat_model_stream_events` →
 *   `_streamChatModelEvents` and `handleChatModelStreamEvent` per
 *   content-block event, with no `handleLLMNewToken` at all. This is the
 *   shape of LangGraph's v3 `streamEvents` messages handler, i.e. what the
 *   agent runtime (`agent.streamEvents(…, { version: "v3" })`) drives.
 */
export type HandlerShape = "llm-new-token" | "chat-model-stream-events";

/**
 * Records the chat-model callback traffic exactly as LangGraph's streaming
 * handlers receive it — the agent's `model.invoke(messages, config)` path.
 */
class RecordingHandler extends BaseCallbackHandler {
  name = "stream-characterization-recorder";
  lc_prefer_streaming: boolean;
  lc_prefer_chat_model_stream_events: boolean;
  awaitHandlers: boolean;
  readonly events: Record<string, unknown>[] = [];

  constructor(shape: HandlerShape) {
    super();
    const v3 = shape === "chat-model-stream-events";
    this.lc_prefer_streaming = !v3;
    this.lc_prefer_chat_model_stream_events = v3;
    // LangGraph's v3 messages handler awaits its callbacks.
    this.awaitHandlers = v3;
  }

  /**
   * The facade can reject before LangChain has unwound the SDK stream, so the
   * terminal callback (`llm_end` / `llm_error`) may land after the caller's
   * promise settled. Wait for it (bounded) so a record is deterministic.
   */
  async settled(maxWaitMs: number) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      if (
        this.events.some(
          (event) => event.event === "llm_end" || event.event === "llm_error",
        )
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  handleChatModelStart() {
    this.events.push({ event: "chat_model_start" });
  }

  handleLLMNewToken(
    token: string,
    _idx: NewTokenIndices,
    _runId: string,
    _parentRunId?: string,
    _tags?: string[],
    fields?: HandleLLMNewTokenCallbackFields,
  ) {
    const chunk = fields?.chunk as ChatGenerationChunk | undefined;
    this.events.push({
      event: "llm_new_token",
      token,
      chunk: chunk ? normalizeMessage(chunk.message) : undefined,
      finishReason: chunk?.generationInfo?.finish_reason,
    });
  }

  handleChatModelStreamEvent(event: ChatModelStreamEvent) {
    this.events.push({ event: "chat_model_stream_event", payload: event });
  }

  handleLLMEnd(output: {
    generations: Array<Array<{ message?: unknown; text?: string }>>;
    llmOutput?: unknown;
  }) {
    const generation = output.generations[0]?.[0];
    this.events.push({
      event: "llm_end",
      text: generation?.text,
      message: generation?.message
        ? normalizeMessage(generation.message)
        : undefined,
      llmOutput: output.llmOutput,
    });
  }

  handleLLMError(error: unknown) {
    this.events.push({
      event: "llm_error",
      errorCode: normalizeGatewayError(error).code,
      name: (error as { name?: string })?.name,
    });
  }
}

/** Message/chunk projection with ids stripped (they carry the LangChain run id). */
export function normalizeMessage(message: unknown): Record<string, unknown> {
  const record = (message ?? {}) as Record<string, unknown>;
  const additional = (record.additional_kwargs ?? {}) as Record<
    string,
    unknown
  >;
  const responseMetadata = {
    ...((record.response_metadata ?? {}) as Record<string, unknown>),
  };
  // `__includeRawResponse` echoes the provider chunk; the chunk's own id is in
  // it, so it is projected to the fields that matter for the sequence.
  const rawResponse = additional.__raw_response as
    Record<string, unknown> | undefined;
  const toolCalls = Array.isArray(record.tool_calls)
    ? (record.tool_calls as Array<Record<string, unknown>>).map((call) => ({
        id: call.id,
        name: call.name,
        args: call.args,
      }))
    : undefined;
  const toolCallChunks = Array.isArray(record.tool_call_chunks)
    ? (record.tool_call_chunks as Array<Record<string, unknown>>).map(
        (call) => ({
          index: call.index,
          id: call.id,
          name: call.name,
          args: call.args,
        }),
      )
    : undefined;
  return {
    type:
      typeof (record as { _getType?: () => string })._getType === "function"
        ? (record as { _getType: () => string })._getType()
        : record.type,
    content: record.content,
    reasoning: additional.reasoning_content,
    toolCallChunks,
    toolCalls,
    usage: record.usage_metadata,
    finishReason:
      responseMetadata.finish_reason ?? responseMetadata.finishReason,
    responseMetadata,
    rawUsage: rawResponse?.usage,
  };
}

export type RecordedRun = {
  entry: "invoke" | "stream";
  handlerShape: HandlerShape;
  callbacks: Record<string, unknown>[];
  /** `model.stream` chunks as the consumer sees them. */
  chunks?: Record<string, unknown>[];
  /** invoke result, or the concat of every stream chunk. */
  final?: Record<string, unknown>;
  error?: { code: string; name?: string; message: string };
  observation: {
    starts: Array<{ operation: string }>;
    ends: Array<{
      finishReason?: string;
      usage?: unknown;
      outputText?: string;
      reasoningText?: string;
      output?: Record<string, unknown>;
    }>;
    errors: Array<{
      errorCode?: string;
      finishReason?: string;
      usage?: unknown;
      output?: Record<string, unknown>;
    }>;
  };
  warnings: Array<{ message: string; data?: Record<string, unknown> }>;
  elapsedMs: number;
  requestBodies: Record<string, unknown>[];
};

export type HarnessOptions = {
  baseUrl: string;
  entry: "invoke" | "stream";
  timeoutMs: number;
  providerKind?: ProviderKind;
  /** Caller signal, as the agent runtime always passes one. */
  signal?: AbortSignal;
  thinking?: boolean;
  tools?: boolean;
  logger?: GatewayLogger;
  /** Extra config fields (e.g. injected guard thresholds). */
  config?: Partial<ModelGatewayConfig>;
  /** Pass callbacks as a CallbackManager (LangGraph's shape) instead of an array. */
  callbacksAsManager?: boolean;
  /**
   * Pass no callbacks at all: core then does not stream internally on
   * `invoke`, so nothing observes the call chunk by chunk.
   */
  withoutCallbacks?: boolean;
  /** Which internal streaming path `invoke` takes; defaults to `llm-new-token`. */
  handlerShape?: HandlerShape;
  /** The fake server's request log, to record the bodies this run sent. */
  requests?: Array<{ body: Record<string, unknown> }>;
};

/**
 * Builds the model the way `apps/backend` does (`createAgentChatModel` →
 * `createLangChainChatModel`, DeepSeek adapter, observeSink, logger), runs one
 * call with LangGraph-shaped options, and returns the whole event record.
 */
export async function recordRun(options: HarnessOptions): Promise<RecordedRun> {
  const providerKind = options.providerKind ?? "deepseek";
  const observation: RecordedRun["observation"] = {
    starts: [],
    ends: [],
    errors: [],
  };
  const warnings: RecordedRun["warnings"] = [];
  const config: ModelGatewayConfig = {
    providers: {
      fake: {
        kind: providerKind,
        baseUrl: options.baseUrl,
        apiKey: "fake-key",
      },
    },
    modelRoutes: {
      chat: {
        strategy: "priority",
        targets: [{ provider: "fake", model: "fake-model", priority: 1 }],
      },
    },
    timeoutMs: options.timeoutMs,
    maxRetries: 0,
    logger: {
      ...options.logger,
      warn: (message, data) => {
        warnings.push({ message, data });
        options.logger?.warn?.(message, data);
      },
    },
    observeSink: {
      onGenerationStart: (event: ObserveGenerationStart) => {
        observation.starts.push({ operation: event.operation });
      },
      onGenerationEnd: (event: ObserveGenerationEnd) => {
        observation.ends.push({
          finishReason: event.finishReason,
          usage: event.usage,
          outputText: event.outputText,
          reasoningText: event.reasoningText,
          output: event.output,
        });
      },
      onGenerationError: (event: ObserveGenerationError) => {
        observation.errors.push({
          errorCode: event.errorCode,
          finishReason: (event as { finishReason?: string }).finishReason,
          usage: event.usage,
          output: (event as { output?: Record<string, unknown> }).output,
        });
      },
    },
    ...options.config,
  };

  const base = (await createLangChainChatModel({
    modelAlias: "chat",
    config,
    execution: options.thinking ? { thinking: { enabled: true } } : undefined,
  })) as unknown as LangChainChatModelLike;
  const model =
    options.tools && base.bindTools
      ? base.bindTools([
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Look something up",
              parameters: {
                type: "object",
                properties: { q: { type: "string" } },
                required: ["q"],
              },
            },
          },
        ])
      : base;

  const handlerShape = options.handlerShape ?? "llm-new-token";
  const recorder = new RecordingHandler(handlerShape);
  const requestsBefore = options.requests?.length ?? 0;
  const callbacks = options.callbacksAsManager
    ? CallbackManager.fromHandlers({}).copy([recorder], true)
    : [recorder];
  const callOptions = {
    ...(options.withoutCallbacks ? {} : { callbacks }),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const messages = [{ role: "user", content: "hello" }];
  const startedAt = Date.now();
  const run: RecordedRun = {
    entry: options.entry,
    handlerShape,
    callbacks: recorder.events,
    observation,
    warnings,
    elapsedMs: 0,
    requestBodies: [],
  };
  try {
    if (options.entry === "invoke") {
      const result = await model.invoke(messages, callOptions);
      run.final = normalizeMessage(result);
    } else {
      const chunks: Record<string, unknown>[] = [];
      run.chunks = chunks;
      let aggregate: { concat(other: unknown): unknown } | undefined;
      for await (const chunk of await model.stream(messages, callOptions)) {
        chunks.push(normalizeMessage(chunk));
        aggregate = aggregate
          ? (aggregate.concat(chunk) as typeof aggregate)
          : (chunk as typeof aggregate);
      }
      run.final = aggregate ? normalizeMessage(aggregate) : undefined;
    }
  } catch (error) {
    const normalized = normalizeGatewayError(error);
    run.error = {
      code: normalized.code,
      name: (error as { name?: string })?.name,
      message: normalized.message,
    };
  }
  run.elapsedMs = Date.now() - startedAt;
  if (!options.withoutCallbacks) await recorder.settled(1_000);
  run.requestBodies = (options.requests ?? [])
    .slice(requestsBefore)
    .map((request) => request.body);
  return run;
}

/**
 * Drop what is not part of the event sequence (timing, logger output) so a
 * record can be compared with a golden.
 */
export function toGolden(run: RecordedRun) {
  const { elapsedMs: _elapsed, warnings: _warnings, ...rest } = run;
  return rest;
}
