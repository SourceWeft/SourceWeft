import { AsyncLocalStorage } from "node:async_hooks";
import {
  createMiddleware,
  modelRetryMiddleware,
  type AgentMiddleware,
} from "langchain";
import { logger } from "../../../../shared/logger";
import {
  isRetryableModelContentError,
  MODEL_REASONING_BUDGET_EXCEEDED_CODE,
  MODEL_STREAM_DURATION_EXCEEDED_CODE,
  toContentError,
} from "../../../content/model-gateway-error";
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
 *   `MODEL_STREAM_DURATION_EXCEEDED` (the same prompt almost always overruns
 *   again; one more attempt is the cap).
 * - `attempt` (innermost) wraps each attempt the retry loop makes: it is the
 *   only hook that sees every attempt individually, so it owns the counter and
 *   the timer. `wrapModelCall` handlers compose first-is-outermost
 *   (`AgentNode`), which is why the array order below is load-bearing.
 *
 * No middleware here keeps state beyond the scope of one model call.
 */

export const MODEL_CALL_RETRY_EVENT = "agent.model_call.retry" as const;
export const MODEL_CALL_FAILED_EVENT = "agent.model_call.failed" as const;

/** Retries after the initial attempt (LangChain default restated). */
export const MODEL_CALL_MAX_RETRIES = 2;
/** First backoff delay; doubles per retry (LangChain default restated). */
export const MODEL_CALL_RETRY_INITIAL_DELAY_MS = 1_000;
export const MODEL_CALL_RETRY_BACKOFF_FACTOR = 2;
/**
 * A reasoning-budget or stream-duration overrun is retried at most once per
 * model call: the model itself, not the transport, ran away, so a second
 * replay of the same prompt is unlikely to end differently. Beyond the cap
 * the retry predicate reports the error as not retryable and the retry
 * middleware's `onFailure: "error"` surfaces it.
 */
export const REASONING_BUDGET_MAX_RETRIES = 1;
export const SINGLE_RETRY_CONTENT_ERROR_CODES: ReadonlySet<string> = new Set([
  MODEL_REASONING_BUDGET_EXCEEDED_CODE,
  MODEL_STREAM_DURATION_EXCEEDED_CODE,
]);

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
      try {
        return await handler(request);
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
