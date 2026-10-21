import { AsyncLocalStorage } from "node:async_hooks";
import { getWriter } from "@langchain/langgraph";
import {
  createMiddleware,
  modelRetryMiddleware,
  type AgentMiddleware,
} from "langchain";
import { logger } from "../../../../shared/logger";
import {
  createModelOutputTruncatedContentError,
  isRetryableModelContentError,
  MODEL_OUTPUT_TRUNCATED_CODE,
  MODEL_REASONING_BUDGET_EXCEEDED_CODE,
  MODEL_STREAM_DURATION_EXCEEDED_CODE,
  toContentError,
} from "../../../content/model-gateway-error";
import { extractFinishReasonFromMessageChunk } from "../turn/content";
import { currentAgentStepScope } from "./step-budget";
import type { SourceWeftToolObservabilityContext } from "./tool-observability";

/**
 * Bounded same-step retry for provider-side model failures, with one log line
 * per failed attempt.
 *
 * LangChain's `modelRetryMiddleware` (langchain 1.5.x) already does the retry:
 * it loops `handler(request)` inside `wrapModelCall`, so a retried attempt
 * never re-enters `beforeModel` and therefore never charges the step budget
 * (`SourceWeftRunStepBudget` counts in `beforeModel`). Its defaults are
 * 2 retries (3 attempts), exponential backoff `1000ms * 2^n` capped at 60 s
 * with ±25% jitter. They are restated here explicitly so the policy is
 * visible at the call site rather than inherited silently.
 *
 * What LangChain does not provide: any observability of a failed attempt, or
 * a per-error-code retry budget. Both are added here without a second retry
 * loop:
 *
 * - `scope` (outermost of the three) opens a per-model-call AsyncLocalStorage
 *   scope: attempt counter, per-attempt timer, failures by content code.
 * - `modelRetryMiddleware` sits inside it with a `retryOn` predicate that
 *   reads the scope to log `agent.model_call.retry` / `agent.model_call.failed`
 *   and to refuse a second retry of `MODEL_REASONING_BUDGET_EXCEEDED` /
 *   `MODEL_STREAM_DURATION_EXCEEDED` / `MODEL_OUTPUT_TRUNCATED` (the same
 *   prompt almost always overruns again; one more attempt is the cap).
 * - `attempt` (innermost) wraps each attempt the retry loop makes: it is the
 *   only hook that sees every attempt individually, so it owns the counter and
 *   the timer. `wrapModelCall` handlers compose first-is-outermost
 *   (`AgentNode`), which is why the array order below is load-bearing. It is
 *   also where the truncated-tool-call backstop lives (see
 *   {@link isToolCallTruncatedByOutputLimit}): a response the gateway let
 *   through with `finish_reason: "length"` and tool calls is turned into the
 *   same `MODEL_OUTPUT_TRUNCATED` failure the gateway would have raised, from
 *   inside the retry loop, so it is retried instead of executed.
 *
 * Stream side: each attempt announces itself with a LangGraph custom event
 * (`model-call-begin`) and a retry decision emits `model-call-retry` before
 * the next attempt starts. The turn's custom-stream handler turns the pair into
 * a `segment-reset` so the client withdraws what the failed attempt streamed
 * instead of seeing it replayed. Both are written through `getWriter()` (as
 * the step budget's progress is), so they ride the same ordered stream as the
 * model's own message chunks. Only the main graph writes them: a sub-agent's
 * custom events surface under the parent's `tools:` namespace (depth 1, which
 * the runner treats as main, unlike the child's depth-2 `messages` events),
 * so a child's retry is gated here, at the source, the way the step budget
 * emits progress for `main` only.
 *
 * Ordering assumption: `getWriter()` pushes a custom event straight onto the
 * run stream, whereas the model's chunks reach it through LangChain's shared,
 * non-awaited callback queue. A `model-call-retry` therefore lands after the
 * failed attempt's chunks only because that queue is idle in this process (no
 * other async callback handlers are registered). An environment that adds one
 * — a LangSmith tracer, say — could delay late chunks past the reset, and the
 * client would then append a withdrawn fragment to the retried attempt.
 *
 * No middleware here keeps state beyond the scope of one model call.
 */

export const MODEL_CALL_RETRY_EVENT = "agent.model_call.retry" as const;
export const MODEL_CALL_FAILED_EVENT = "agent.model_call.failed" as const;

/** Custom stream event: a model-call attempt (`attempt`, 1-based) is starting. */
export const MODEL_CALL_BEGIN_CUSTOM_EVENT = "model-call-begin" as const;
/** Custom stream event: a retry was granted; `attempt` is the one about to start. */
export const MODEL_CALL_RETRY_CUSTOM_EVENT = "model-call-retry" as const;

export type ModelCallBeginCustomEvent = {
  type: typeof MODEL_CALL_BEGIN_CUSTOM_EVENT;
  attempt: number;
};
export type ModelCallRetryCustomEvent = {
  type: typeof MODEL_CALL_RETRY_CUSTOM_EVENT;
  attempt: number;
  errorCode: string;
};

function writeCustomEvent(
  event: ModelCallBeginCustomEvent | ModelCallRetryCustomEvent,
) {
  if (!isMainGraphModelCall()) return;
  getWriter()?.(event);
}

function isMainGraphModelCall(): boolean {
  try {
    return currentAgentStepScope() === "main";
  } catch {
    // No graph scope: the middleware is being driven outside a LangGraph run,
    // where there is no stream to write to either.
    return false;
  }
}

/** Retries after the initial attempt (LangChain default restated). */
export const MODEL_CALL_MAX_RETRIES = 2;
/** First backoff delay; doubles per retry (LangChain default restated). */
export const MODEL_CALL_RETRY_INITIAL_DELAY_MS = 1_000;
export const MODEL_CALL_RETRY_BACKOFF_FACTOR = 2;
/**
 * A reasoning-budget, stream-duration or output-limit overrun is retried at
 * most once per model call: the model itself, not the transport, ran away (or
 * out of output budget), so a second replay of the same prompt is unlikely to
 * end differently. Beyond the cap the retry predicate reports the error as
 * not retryable and the retry middleware's `onFailure: "error"` surfaces it.
 */
export const REASONING_BUDGET_MAX_RETRIES = 1;
export const SINGLE_RETRY_CONTENT_ERROR_CODES: ReadonlySet<string> = new Set([
  MODEL_REASONING_BUDGET_EXCEEDED_CODE,
  MODEL_STREAM_DURATION_EXCEEDED_CODE,
  MODEL_OUTPUT_TRUNCATED_CODE,
]);

function toRecord(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyArray(value: unknown) {
  return Array.isArray(value) && value.length > 0;
}

const TOOL_CALL_CONTENT_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "tool_call",
  "invalid_tool_call",
  "tool_call_chunk",
  "tool_use",
  "input_json_delta",
]);

/**
 * Core's v1 message assembly (`ChatModelStream._assembleMessage`, the path a
 * v3 `streamEvents` run takes) finalizes a tool block whose JSON will not
 * parse as an `invalid_tool_call` *content block*, and `AIMessage` does not
 * backfill `invalid_tool_calls` from content. The block is still the record
 * that a tool call was being emitted when the output stopped.
 */
function hasToolCallContentBlock(content: unknown) {
  return (
    Array.isArray(content) &&
    content.some((block) => {
      const type = toRecord(block)?.type;
      return (
        typeof type === "string" && TOOL_CALL_CONTENT_BLOCK_TYPES.has(type)
      );
    })
  );
}

/**
 * Second line of defence for issue #338. A provider that stops at its output
 * token limit in the middle of a tool call answers HTTP 200 with
 * `finish_reason: "length"` and an unterminated `arguments` string; LangChain's
 * chunk aggregation repairs the partial JSON into a valid-looking `tool_calls`
 * entry, so the tools node would execute a truncated `write_file`. The gateway
 * facade raises `OUTPUT_TRUNCATED` for this shape first; this check catches a
 * response that reached the agent anyway (a provider or adapter path that
 * bypasses the facade). Both the OpenAI-compatible `finish_reason` and the
 * v3 `finishReason` spelling are read. Any tool-call evidence counts —
 * parsed (`tool_calls`), chunked, unparseable (`invalid_tool_calls`), or a
 * tool block left in v1 content — because the response was cut while the
 * model was emitting a call either way. A `length` finish on a plain-text
 * answer is delivered unchanged.
 */
export function isToolCallTruncatedByOutputLimit(response: unknown): boolean {
  const record = toRecord(response);
  if (!record) return false;
  if (extractFinishReasonFromMessageChunk(record) !== "length") return false;
  return (
    nonEmptyArray(record.tool_calls) ||
    nonEmptyArray(record.tool_call_chunks) ||
    nonEmptyArray(record.invalid_tool_calls) ||
    hasToolCallContentBlock(record.content)
  );
}

function throwIfToolCallTruncated(response: unknown) {
  if (!isToolCallTruncatedByOutputLimit(response)) return;
  const metadata = toRecord(toRecord(response)?.response_metadata);
  throw createModelOutputTruncatedContentError({
    provider: metadata?.model_provider,
    requestId: metadata?.id ?? metadata?.requestId,
  });
}

type ModelCallScope = {
  /** Attempts started for this model call (1-based once the first begins). */
  attempt: number;
  attemptStartedAt: number;
  lastFailure?: {
    attempt: number;
    elapsedMs: number;
    errorCode: string;
    errorName: string;
    gatewayCode?: string;
  };
  failuresByCode: Map<string, number>;
};

const modelCallScope = new AsyncLocalStorage<ModelCallScope>();

export type SourceWeftModelRetryMiddlewareInput = {
  context?: SourceWeftToolObservabilityContext;
  /** Overrides for tests; production uses the restated LangChain defaults. */
  retry?: {
    maxRetries?: number;
    initialDelayMs?: number;
    backoffFactor?: number;
    jitter?: boolean;
  };
};

type FailureDescription = {
  errorCode: string;
  errorName: string;
  gatewayCode?: string;
};

function describeFailure(error: unknown): FailureDescription {
  const content = toContentError(error);
  const details =
    content.details && typeof content.details === "object"
      ? (content.details as Record<string, unknown>)
      : null;
  const gatewayCode =
    typeof details?.gatewayCode === "string" ? details.gatewayCode : undefined;
  const errorName =
    error instanceof Error && error.name.trim().length > 0
      ? error.name
      : "Error";
  return { errorCode: content.code, errorName, gatewayCode };
}

function logMeta(
  context: SourceWeftToolObservabilityContext | undefined,
  fields: Record<string, unknown>,
) {
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({
    threadId: context?.threadId,
    runId: context?.runId,
    userMessageId: context?.userMessageId,
    subagentType: context?.subagentType,
    ...fields,
  })) {
    if (value !== undefined && value !== null) meta[key] = value;
  }
  return meta;
}

/**
 * The three middleware, in the order they must appear in the stack. Spread the
 * result in place of a bare `modelRetryMiddleware(...)`.
 */
export function createSourceWeftModelRetryMiddleware(
  input: SourceWeftModelRetryMiddlewareInput = {},
): AgentMiddleware[] {
  const maxRetries = input.retry?.maxRetries ?? MODEL_CALL_MAX_RETRIES;
  const maxAttempts = maxRetries + 1;
  const context = input.context;

  const scope = createMiddleware({
    name: "SourceWeftModelCallScope",
    wrapModelCall: (request, handler) =>
      modelCallScope.run(
        { attempt: 0, attemptStartedAt: 0, failuresByCode: new Map() },
        () => handler(request),
      ),
  });

  const retryOn = (error: Error): boolean => {
    const current = modelCallScope.getStore();
    const retryable = isRetryableModelContentError(error);
    const failure = current?.lastFailure ?? describeFailure(error);
    const attempt = current?.lastFailure?.attempt;
    const elapsedMs = current?.lastFailure?.elapsedMs;
    const codeFailures =
      current?.failuresByCode.get(failure.errorCode) ?? attempt ?? 1;

    let reason: "not_retryable" | "code_budget" | "exhausted" | null = null;
    if (!retryable) {
      reason = "not_retryable";
    } else if (
      SINGLE_RETRY_CONTENT_ERROR_CODES.has(failure.errorCode) &&
      codeFailures > REASONING_BUDGET_MAX_RETRIES
    ) {
      reason = "code_budget";
    } else if (attempt !== undefined && attempt >= maxAttempts) {
      reason = "exhausted";
    }

    const fields = {
      attempt,
      maxAttempts,
      errorCode: failure.errorCode,
      gatewayCode: failure.gatewayCode,
      errorName: failure.errorName,
      retryable,
      elapsedMs,
    };
    if (reason === null) {
      logger.warn(MODEL_CALL_RETRY_EVENT, logMeta(context, fields));
      writeCustomEvent({
        type: MODEL_CALL_RETRY_CUSTOM_EVENT,
        attempt: (attempt ?? 1) + 1,
        errorCode: failure.errorCode,
      });
      return true;
    }
    logger.warn(
      MODEL_CALL_FAILED_EVENT,
      logMeta(context, { ...fields, reason }),
    );
    return false;
  };

  const retry = modelRetryMiddleware({
    maxRetries,
    initialDelayMs:
      input.retry?.initialDelayMs ?? MODEL_CALL_RETRY_INITIAL_DELAY_MS,
    backoffFactor:
      input.retry?.backoffFactor ?? MODEL_CALL_RETRY_BACKOFF_FACTOR,
    ...(input.retry?.jitter === undefined
      ? {}
      : { jitter: input.retry.jitter }),
    retryOn,
    onFailure: "error",
  });

  const attempt = createMiddleware({
    name: "SourceWeftModelCallAttempt",
    wrapModelCall: async (request, handler) => {
      const current = modelCallScope.getStore();
      const startedAt = Date.now();
      if (current) {
        current.attempt += 1;
        current.attemptStartedAt = startedAt;
      }
      writeCustomEvent({
        type: MODEL_CALL_BEGIN_CUSTOM_EVENT,
        attempt: current?.attempt ?? 1,
      });
      try {
        const response = await handler(request);
        // Inside the try so a truncated response is recorded as this
        // attempt's failure, exactly like an error thrown by the gateway.
        throwIfToolCallTruncated(response);
        return response;
      } catch (error) {
        if (current) {
          const failure = describeFailure(error);
          current.failuresByCode.set(
            failure.errorCode,
            (current.failuresByCode.get(failure.errorCode) ?? 0) + 1,
          );
          current.lastFailure = {
            ...failure,
            attempt: current.attempt,
            elapsedMs: Date.now() - startedAt,
          };
        }
        throw error;
      }
    },
  });

  return [scope, retry, attempt];
}
