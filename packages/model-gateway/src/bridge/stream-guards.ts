import {
  BaseCallbackHandler,
  type HandleLLMNewTokenCallbackFields,
  type NewTokenIndices,
} from "@langchain/core/callbacks/base";
import type { CallbackManager } from "@langchain/core/callbacks/manager";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import { ModelGatewayError } from "../errors";
import type {
  GatewayErrorCode,
  ResolvedRequestTarget,
  StreamGuardThresholds,
} from "../types";

/**
 * After the first chunk, the longest gap tolerated between two chunks. A
 * provider that stops sending bytes without closing the connection is cut
 * here instead of living until the socket dies.
 */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

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
};

/** The observation `finishReason` a guard interruption is recorded under. */
export function guardFinishReason(code: GatewayErrorCode): string | undefined {
  return GUARD_FINISH_REASONS[code];
}

export type StreamGuardState = {
  chunks: number;
  reasoningChars: number;
  startedAtMs: number;
  firstChunkAtMs?: number;
  lastChunkAtMs?: number;
  /** Last `usage_metadata` seen on a chunk, raw (LangChain shape). */
  usage?: unknown;
};

export type AttemptGuard = {
  /** Caller abort, first-token timeout, idle timeout and reasoning budget, combined. */
  readonly signal: AbortSignal;
  readonly state: Readonly<StreamGuardState>;
  /** Feed one streamed chunk (an AIMessageChunk-like value). */
  observeChunk(chunk: unknown): void;
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
  function observe(progress: { reasoningChars: number; usage?: unknown }) {
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

  function observeChunk(chunk: unknown) {
    const record = chunk as
      | {
          additional_kwargs?: { reasoning_content?: unknown };
          usage_metadata?: unknown;
        }
      | undefined;
    const reasoning = record?.additional_kwargs?.reasoning_content;
    observe({
      reasoningChars: typeof reasoning === "string" ? reasoning.length : 0,
      usage: record?.usage_metadata,
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
    if (
      event.event === "content-block-delta" &&
      event.delta.type === "reasoning-delta"
    ) {
      reasoningChars = event.delta.reasoning.length;
    } else if (event.event === "usage") {
      usage = event.usage;
    } else if (event.event === "message-finish" && event.usage) {
      usage = event.usage;
    }
    observe({ reasoningChars, usage });
  }

  const handler = new (class extends BaseCallbackHandler {
    name = "model-gateway-stream-guard";
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
      observeChunk(
        (fields?.chunk as { message?: unknown } | undefined)?.message,
      );
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
  return guard?.usage;
}
