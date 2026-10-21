import {
  BaseCallbackHandler,
  type HandleLLMNewTokenCallbackFields,
  type NewTokenIndices,
} from "@langchain/core/callbacks/base";
import type { CallbackManager } from "@langchain/core/callbacks/manager";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import type { LLMResult } from "@langchain/core/outputs";
import { ModelGatewayError } from "../errors";
import type {
  GatewayErrorCode,
  ResolvedRequestTarget,
  StreamGuardThresholds,
} from "../types";

/**
 * After the first chunk, the longest gap tolerated between two chunks. A
 * provider that stops sending bytes without closing the connection is cut
 * here instead of living until the socket dies. 120 s matches the common
 * hosted default (OpenClaw cloud, LobeChat relay first-chunk); every false
 * trip costs a retry and a replay of the partial output, so it is not tighter.
 */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * Cumulative `reasoning_content` characters tolerated in one model call. A
 * model that loops in its thinking phase is stopped here; switching provider
 * cannot help, so the error is retryable but not failoverable.
 */
export const REASONING_CHARS_LIMIT = 200_000;

/**
 * Longest a single model stream may stay open once its first chunk arrived,
 * regardless of pace. A slow-but-steady stream (the 73-minute incident:
 * a reasoning delta every ~300 ms, ~10 chars/s) trips neither the idle guard
 * nor the reasoning cap; this wall clock is what ends it. Not failoverable:
 * the same request on another provider would run just as long.
 */
export const STREAM_MAX_DURATION_MS = 30 * 60_000;

export const DEFAULT_STREAM_GUARDS: StreamGuardThresholds = {
  idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
  reasoningCharsLimit: REASONING_CHARS_LIMIT,
  maxDurationMs: STREAM_MAX_DURATION_MS,
};

/** Node's own `AbortSignal.timeout()` reason text, kept for callers that match on it. */
export const TIMEOUT_ABORT_MESSAGE = "The operation was aborted due to timeout";

const GUARD_FINISH_REASONS: Partial<Record<GatewayErrorCode, string>> = {
  STREAM_IDLE_TIMEOUT: "stream_idle_timeout",
  REASONING_BUDGET_EXCEEDED: "reasoning_budget_exceeded",
  STREAM_DURATION_EXCEEDED: "stream_duration_exceeded",
  OUTPUT_TRUNCATED: "output_truncated",
};

/** The observation `finishReason` a guard interruption is recorded under. */
export function guardFinishReason(code: GatewayErrorCode): string | undefined {
  return GUARD_FINISH_REASONS[code];
}

/**
 * The finish reason a provider reports when it stopped at its output token
 * limit: OpenAI-compatible completions (DeepSeek included) say `length`, and
 * core's v3 `FinishReason` keeps the same word.
 */
export const TRUNCATED_FINISH_REASON = "length";

export type StreamGuardState = {
  chunks: number;
  reasoningChars: number;
  startedAtMs: number;
  firstChunkAtMs?: number;
  lastChunkAtMs?: number;
  /** Last `usage_metadata` seen on a chunk, raw (LangChain shape). */
  usage?: unknown;
  /** Tool-call deltas seen so far (chunk `tool_call_chunks`, v3 tool-call blocks). */
  toolCallChunks: number;
  /** Last finish reason seen on a chunk, a generation or a v3 `message-finish`. */
  finishReason?: string;
};

type MessageLike = {
  content?: unknown;
  tool_calls?: unknown;
  tool_call_chunks?: unknown;
  invalid_tool_calls?: unknown;
  response_metadata?: { finish_reason?: unknown; finishReason?: unknown };
  usage_metadata?: unknown;
  additional_kwargs?: { reasoning_content?: unknown };
};

const lengthOf = (value: unknown) => (Array.isArray(value) ? value.length : 0);

/**
 * Content block types that are a tool call, in v1 (standard) content and in
 * provider-native content: core's `tool_call` / `invalid_tool_call` /
 * `tool_call_chunk`, Anthropic's `tool_use` and its streamed
 * `input_json_delta`. The v3 aggregate finalizes a cut tool block as an
 * `invalid_tool_call` content block and does not backfill
 * `invalid_tool_calls` from content, so the block is the only evidence there.
 */
const TOOL_CALL_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "tool_call",
  "invalid_tool_call",
  "tool_call_chunk",
  "tool_use",
  "input_json_delta",
]);

/** A content block (v1 content, v3 start content or block-delta fields) that is a tool call. */
function isToolCallBlock(block: unknown): boolean {
  const type = (block as { type?: unknown } | undefined)?.type;
  return typeof type === "string" && TOOL_CALL_BLOCK_TYPES.has(type);
}

/**
 * Tool calls a message or chunk carries, whichever field the driver filled:
 * `tool_call_chunks` on streamed chunks, `tool_calls` on aggregated or
 * non-streamed messages, `invalid_tool_calls` when the arguments could not
 * even be repaired into JSON, or tool blocks in array content (the v3
 * aggregate). The backend's `isToolCallTruncatedByOutputLimit` backstop
 * mirrors this predicate; keep the two in step.
 */
export function toolCallCount(message: unknown): number {
  const record = message as MessageLike | undefined;
  const content = record?.content;
  return Math.max(
    lengthOf(record?.tool_calls),
    lengthOf(record?.tool_call_chunks),
    lengthOf(record?.invalid_tool_calls),
    Array.isArray(content) ? content.filter(isToolCallBlock).length : 0,
  );
}

function messageFinishReason(message: unknown): string | undefined {
  const metadata = (message as MessageLike | undefined)?.response_metadata;
  if (typeof metadata?.finish_reason === "string")
    return metadata.finish_reason;
  if (typeof metadata?.finishReason === "string") return metadata.finishReason;
  return undefined;
}

/**
 * The error for a response the provider cut at its output token limit in the
 * middle of a tool call (`finish_reason: "length"` with tool calls present).
 * The arguments JSON is incomplete, and LangChain's chunk aggregation repairs
 * partial JSON into a valid-looking `tool_calls` entry (`invalid_tool_calls`
 * stays empty), so a caller that trusted the message would execute a
 * truncated call. A `length` finish without a tool call is not an error: the
 * text is delivered as is, with its finish reason. Retryable, not
 * failoverable: another provider of the same request cuts at the same budget.
 */
export function truncatedToolCallError(input: {
  finishReason: string | undefined;
  toolCalls: number;
  target: Pick<ResolvedRequestTarget, "provider" | "providerModel">;
  usage?: unknown;
}): ModelGatewayError | undefined {
  if (input.finishReason !== TRUNCATED_FINISH_REASON || input.toolCalls <= 0)
    return undefined;
  return new ModelGatewayError({
    code: "OUTPUT_TRUNCATED",
    message: `The model hit its output token limit (finish_reason: ${TRUNCATED_FINISH_REASON}) while writing a tool call, so the call's arguments are incomplete and it was not executed. Try again, or ask for a smaller result (for example split the task or shorten the content).`,
    retryable: true,
    provider: input.target.provider,
    metadata: {
      outputTruncated: {
        finishReason: input.finishReason,
        toolCalls: input.toolCalls,
        providerModel: input.target.providerModel,
        ...(input.usage !== undefined ? { usage: input.usage } : {}),
      },
    },
  });
}

/**
 * {@link truncatedToolCallError} for a completed message: an `invoke` result
 * or the concat of a stream. Non-streamed and v3-aggregated messages carry
 * the finish reason in `response_metadata`; the `handleLLMNewToken`
 * aggregate does not (core keeps it on the generation), which is why the
 * attempt guard also tracks it per chunk.
 */
export function truncatedToolCallMessageError(
  message: unknown,
  target: Pick<ResolvedRequestTarget, "provider" | "providerModel">,
): ModelGatewayError | undefined {
  return truncatedToolCallError({
    finishReason: messageFinishReason(message),
    toolCalls: toolCallCount(message),
    target,
    usage: (message as MessageLike | undefined)?.usage_metadata,
  });
}

export type AttemptGuard = {
  /** Caller abort, first-token timeout, idle timeout and reasoning budget, combined. */
  readonly signal: AbortSignal;
  readonly state: Readonly<StreamGuardState>;
  /**
   * Feed one streamed chunk (an AIMessageChunk-like value). The generation's
   * `finish_reason` may be passed alongside for chunks whose message does not
   * carry it (`handleLLMNewToken` leaves it on the `ChatGenerationChunk`).
   */
  observeChunk(chunk: unknown, finishReason?: string): void;
  /** Feed one content-block stream event (the `_streamChatModelEvents` shape). */
  observeStreamEvent(event: ChatModelStreamEvent): void;
  /**
   * LangChain callbacks for the invoke path: the model streams internally
   * when a handler prefers streaming (`handleLLMNewToken`) or chat-model
   * stream events (`handleChatModelStreamEvent`, LangGraph v3), and the
   * guard sees every chunk through whichever of the two core picks. Returns the caller's callbacks untouched when there
   * are none — without callbacks the model does not stream, so there is
   * nothing to watch and adding a run manager would alter the message id.
   */
  callbacks(existing: unknown): unknown;
  /**
   * The error this attempt should surface: the guard's own verdict when it
   * tripped (LangChain reports a generic abort by then), else the error as is.
   */
  verdict(error: unknown): unknown;
  /**
   * The verdict on a response that completed: `OUTPUT_TRUNCATED` when the
   * provider stopped at its output limit mid tool call, judged from what the
   * guard observed plus, when given, the completed message itself (the only
   * evidence on a non-streamed `invoke`, which no callback observes).
   * `undefined` when the response may be delivered.
   */
  completion(completed?: {
    message?: unknown;
    finishReason?: string;
  }): ModelGatewayError | undefined;
  /** Stop timers; idempotent. Required once the attempt settles. */
  settle(): void;
};

/**
 * One target attempt's lifecycle guard.
 *
 * - Before the first chunk the attempt `timeoutMs` applies (first-token
 *   timeout, surfaced as `TIMEOUT` exactly like `AbortSignal.timeout`).
 * - From the first chunk on, the total timeout is disarmed and an idle
 *   watchdog (`STREAM_IDLE_TIMEOUT`) is re-armed on every chunk, so a long
 *   but live output is never cut by the attempt budget.
 * - Cumulative `reasoning_content` beyond the limit trips
 *   `REASONING_BUDGET_EXCEEDED`.
 * - A `length` finish after tool-call deltas trips `OUTPUT_TRUNCATED` once
 *   the response completes (`handleLLMEnd` on the invoke path, so the verdict
 *   is on the attempt signal before `invoke` resolves; `completion()` for the
 *   stream path and for calls no callback observes).
 * - The caller's signal is always honoured; its reason wins untouched.
 *
 * A trip aborts `signal`, which the SDK fetch and every `awaitWithSignal`
 * race observe immediately — the consumer does not wait for the next chunk.
 */
export function createAttemptGuard(input: {
  signal?: AbortSignal;
  firstTokenTimeoutMs: number;
  thresholds: StreamGuardThresholds;
  target: Pick<ResolvedRequestTarget, "provider" | "providerModel">;
}): AttemptGuard {
  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  const state: StreamGuardState = {
    chunks: 0,
    reasoningChars: 0,
    startedAtMs: Date.now(),
    toolCallChunks: 0,
  };
  let settled = false;
  let tripped: unknown;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;

  const trip = (reason: unknown) => {
    // A caller abort (the composite signal) wins: a guard that fires while
    // the call unwinds must not replace the caller's reason.
    if (settled || signal.aborted) return;
    tripped = reason;
    clearTimers();
    controller.abort(reason);
  };

  const guardError = (code: GatewayErrorCode, message: string) =>
    new ModelGatewayError({
      code,
      message,
      retryable: true,
      provider: input.target.provider,
      metadata: {
        streamGuard: {
          ...state,
          elapsedMs: Date.now() - state.startedAtMs,
          providerModel: input.target.providerModel,
          thresholds: { ...input.thresholds },
        },
      },
    });

  let firstTokenTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => {
      firstTokenTimer = undefined;
      trip(new DOMException(TIMEOUT_ABORT_MESSAGE, "TimeoutError"));
    },
    input.firstTokenTimeoutMs,
  );

  function clearTimers() {
    if (firstTokenTimer !== undefined) clearTimeout(firstTokenTimer);
    firstTokenTimer = undefined;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (durationTimer !== undefined) clearTimeout(durationTimer);
    durationTimer = undefined;
  }

  // Armed once, at the first chunk; chunks do not re-arm it.
  function armDuration() {
    durationTimer = setTimeout(() => {
      durationTimer = undefined;
      trip(
        guardError(
          "STREAM_DURATION_EXCEEDED",
          `Model stream stayed open longer than ${input.thresholds.maxDurationMs}ms after its first chunk (${state.chunks} chunk(s), ${state.reasoningChars} reasoning chars)`,
        ),
      );
    }, input.thresholds.maxDurationMs);
  }

  function armIdle() {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      trip(
        guardError(
          "STREAM_IDLE_TIMEOUT",
          `Model stream produced no chunk for ${input.thresholds.idleTimeoutMs}ms after ${state.chunks} chunk(s)`,
        ),
      );
    }, input.thresholds.idleTimeoutMs);
  }

  /** One unit of progress from the provider, whichever shape it arrived in. */
  function observe(progress: {
    reasoningChars: number;
    usage?: unknown;
    toolCallChunks?: number;
    finishReason?: string;
  }) {
    if (settled || signal.aborted) return;
    const now = Date.now();
    state.chunks += 1;
    state.lastChunkAtMs = now;
    if (state.firstChunkAtMs === undefined) {
      state.firstChunkAtMs = now;
      if (firstTokenTimer !== undefined) clearTimeout(firstTokenTimer);
      firstTokenTimer = undefined;
      armDuration();
    }
    state.reasoningChars += progress.reasoningChars;
    if (progress.usage) state.usage = progress.usage;
    state.toolCallChunks += progress.toolCallChunks ?? 0;
    if (progress.finishReason !== undefined)
      state.finishReason = progress.finishReason;
    if (state.reasoningChars > input.thresholds.reasoningCharsLimit) {
      trip(
        guardError(
          "REASONING_BUDGET_EXCEEDED",
          `Model reasoning exceeded ${input.thresholds.reasoningCharsLimit} characters in one call (${state.reasoningChars})`,
        ),
      );
      return;
    }
    armIdle();
  }

  function observeChunk(chunk: unknown, finishReason?: string) {
    const record = chunk as MessageLike | undefined;
    const reasoning = record?.additional_kwargs?.reasoning_content;
    observe({
      reasoningChars: typeof reasoning === "string" ? reasoning.length : 0,
      usage: record?.usage_metadata,
      toolCallChunks: toolCallCount(chunk),
      finishReason: finishReason ?? messageFinishReason(chunk),
    });
  }

  /**
   * Content-block stream events (`_streamChatModelEvents`): the path core
   * takes when a handler prefers chat-model stream events, which LangGraph's
   * v3 `streamEvents` messages handler does. OpenAI-style models drive it
   * natively and never call `handleLLMNewToken` there.
   */
  function observeStreamEvent(event: ChatModelStreamEvent) {
    let reasoningChars = 0;
    let usage: unknown;
    let toolCallChunks = 0;
    let finishReason: string | undefined;
    if (event.event === "content-block-delta") {
      if (event.delta.type === "reasoning-delta") {
        reasoningChars = event.delta.reasoning.length;
      } else if (
        event.delta.type === "block-delta" &&
        isToolCallBlock(event.delta.fields)
      ) {
        toolCallChunks = 1;
      }
    } else if (event.event === "content-block-start") {
      if (isToolCallBlock(event.content)) toolCallChunks = 1;
    } else if (event.event === "usage") {
      usage = event.usage;
    } else if (event.event === "message-finish") {
      if (event.usage) usage = event.usage;
      finishReason = event.reason;
    }
    observe({ reasoningChars, usage, toolCallChunks, finishReason });
  }

  function completion(completed?: {
    message?: unknown;
    finishReason?: string;
  }) {
    const message = completed?.message;
    return truncatedToolCallError({
      finishReason:
        completed?.finishReason ??
        state.finishReason ??
        messageFinishReason(message),
      toolCalls: Math.max(state.toolCallChunks, toolCallCount(message)),
      target: input.target,
      usage:
        state.usage ?? (message as MessageLike | undefined)?.usage_metadata,
    });
  }

  const handler = new (class extends BaseCallbackHandler {
    name = "model-gateway-stream-guard";
    // Run inline rather than on core's background callback queue: the
    // completion verdict in `handleLLMEnd` must be on the attempt signal
    // before `invoke` resolves, and the observations are synchronous anyway.
    awaitHandlers = true;
    handleChatModelStreamEvent(event: ChatModelStreamEvent) {
      observeStreamEvent(event);
    }
    handleLLMNewToken(
      _token: string,
      _idx: NewTokenIndices,
      _runId: string,
      _parentRunId?: string,
      _tags?: string[],
      fields?: HandleLLMNewTokenCallbackFields,
    ) {
      const chunk = fields?.chunk as
        | { message?: unknown; generationInfo?: { finish_reason?: unknown } }
        | undefined;
      const finishReason = chunk?.generationInfo?.finish_reason;
      observeChunk(
        chunk?.message,
        typeof finishReason === "string" ? finishReason : undefined,
      );
    }
    /**
     * Core calls this with the aggregated generation before `invoke`
     * resolves, on every internal path. A truncated tool call trips the
     * attempt here, so the layers above (the observation shim's success
     * path, the failover race) read the verdict off the signal.
     */
    handleLLMEnd(output: LLMResult) {
      const generation = output.generations[0]?.[0] as
        | { message?: unknown; generationInfo?: { finish_reason?: unknown } }
        | undefined;
      const finishReason = generation?.generationInfo?.finish_reason;
      const truncated = completion({
        message: generation?.message,
        ...(typeof finishReason === "string" ? { finishReason } : {}),
      });
      if (truncated) trip(truncated);
    }
  })();

  return {
    signal,
    state,
    observeChunk,
    observeStreamEvent,
    callbacks(existing) {
      if (Array.isArray(existing)) return [...existing, handler];
      const manager = existing as Pick<CallbackManager, "copy"> | undefined;
      if (manager && typeof manager.copy === "function") {
        return manager.copy([handler], false);
      }
      return existing;
    },
    verdict(error) {
      if (tripped === undefined || input.signal?.aborted) return error;
      if (error === tripped || ModelGatewayError.isInstance(error))
        return error;
      return tripped;
    },
    completion,
    settle() {
      settled = true;
      clearTimers();
    },
  };
}

/**
 * The error an attempt's signal carries when it was aborted by a guard trip
 * (a gateway error) or a timeout, for layers that only see LangChain's
 * generic abort error. Returns `undefined` for caller aborts and live signals.
 */
export function abortedAttemptError(
  signal: AbortSignal | undefined,
): unknown | undefined {
  if (!signal?.aborted) return undefined;
  const reason: unknown = signal.reason;
  if (ModelGatewayError.isInstance(reason)) return reason;
  if (
    reason instanceof DOMException &&
    reason.name === "TimeoutError" &&
    reason.message === TIMEOUT_ABORT_MESSAGE
  )
    return reason;
  return undefined;
}

/** `usage_metadata` a guard saw before tripping, if any. */
export function guardUsageFromError(error: unknown): unknown {
  if (!ModelGatewayError.isInstance(error)) return undefined;
  const guard = error.metadata?.streamGuard as { usage?: unknown } | undefined;
  const truncated = error.metadata?.outputTruncated as
    { usage?: unknown } | undefined;
  return guard?.usage ?? truncated?.usage;
}
