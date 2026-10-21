import { ModelGatewayError } from "../../shared/model-gateway/errors";
import { ContentError } from "./errors";

/**
 * ContentError codes for a model call that failed on the provider side —
 * timeout, rate limit, or any other upstream failure — rather than because of
 * the request itself. These are the codes a retry (or the next human message)
 * can reasonably expect to clear.
 */
export const MODEL_REASONING_BUDGET_EXCEEDED_CODE =
  "MODEL_REASONING_BUDGET_EXCEEDED";
export const MODEL_STREAM_DURATION_EXCEEDED_CODE =
  "MODEL_STREAM_DURATION_EXCEEDED";
/**
 * The provider hit its output token limit (`finish_reason: "length"`) while
 * emitting a tool call: the arguments JSON is cut short, and the aggregated
 * message would still present a valid-looking `tool_calls` entry (issue #338).
 * Raised by the gateway (`OUTPUT_TRUNCATED`) or, as a backstop, by the agent's
 * per-attempt model-call observer; both throw this one ContentError so the
 * retry policy treats them alike.
 */
export const MODEL_OUTPUT_TRUNCATED_CODE = "MODEL_OUTPUT_TRUNCATED";
export const MODEL_OUTPUT_TRUNCATED_MESSAGE =
  "The model hit its output limit before finishing a tool call, so the incomplete call was not executed. Try again, or ask for a smaller result (for example split the task or shorten the content).";

export const MODEL_UPSTREAM_CONTENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "MODEL_TIMEOUT",
  "MODEL_RATE_LIMITED",
  "MODEL_UPSTREAM_ERROR",
  // The gateway's per-call reasoning watchdog fired: the model, not the
  // sandbox or the request, is at fault, so a failed run keeps its lease.
  MODEL_REASONING_BUDGET_EXCEEDED_CODE,
  MODEL_STREAM_DURATION_EXCEEDED_CODE,
  // Output cut at max_tokens mid tool call: the model, not the sandbox, is at
  // fault, so a failed run keeps its lease and the step is retried.
  MODEL_OUTPUT_TRUNCATED_CODE,
]);

const RETRYABLE_CONTENT_ERROR_CODES = MODEL_UPSTREAM_CONTENT_ERROR_CODES;

export function isModelUpstreamContentErrorCode(
  code: string | null | undefined,
): boolean {
  return (
    typeof code === "string" && MODEL_UPSTREAM_CONTENT_ERROR_CODES.has(code)
  );
}

function toRecord(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function findGatewayError(
  error: unknown,
  seen = new Set<unknown>(),
): ModelGatewayError | null {
  if (!error || seen.has(error)) {
    return null;
  }
  seen.add(error);

  if (ModelGatewayError.isInstance(error)) {
    return error;
  }

  const record = toRecord(error);
  if (!record) {
    return null;
  }

  const cause = findGatewayError(record.cause, seen);
  if (cause) {
    return cause;
  }

  const nestedError = findGatewayError(record.error, seen);
  if (nestedError) {
    return nestedError;
  }

  return null;
}

function findContentError(
  error: unknown,
  seen = new Set<unknown>(),
): ContentError | null {
  if (!error || seen.has(error)) {
    return null;
  }
  seen.add(error);

  if (error instanceof ContentError) {
    return error;
  }

  const record = toRecord(error);
  if (!record) {
    return null;
  }

  return (
    findContentError(record.cause, seen) ?? findContentError(record.error, seen)
  );
}

function findGatewayErrorData(
  error: unknown,
  seen = new Set<unknown>(),
): {
  code?: unknown;
  message?: unknown;
  provider?: unknown;
  requestId?: unknown;
  retryable?: unknown;
  statusCode?: unknown;
} | null {
  if (!error || seen.has(error)) {
    return null;
  }
  seen.add(error);

  const record = toRecord(error);
  if (!record) {
    return null;
  }

  if (typeof record.code === "string" && typeof record.message === "string") {
    return record;
  }

  return (
    findGatewayErrorData(record.cause, seen) ??
    findGatewayErrorData(record.error, seen)
  );
}

function contentErrorFromGatewayCode(input: {
  code: string;
  message: string;
  provider?: unknown;
  requestId?: unknown;
  retryable?: unknown;
  statusCode?: unknown;
}) {
  const message = sanitizeClientErrorMessage(input.message);
  const metadata = gatewayContentErrorMetadata(input);
  if (input.code === "BAD_REQUEST") {
    return new ContentError(400, "MODEL_REQUEST_INVALID", message, metadata);
  }

  if (input.code === "RATE_LIMIT") {
    return new ContentError(
      429,
      "MODEL_RATE_LIMITED",
      "LLM provider rate limit reached",
      metadata,
    );
  }

  // STREAM_IDLE_TIMEOUT is the gateway's per-chunk watchdog (no data between
  // chunks for STREAM_IDLE_TIMEOUT_MS); to the run it is the same transient
  // condition as a first-token timeout, so it shares MODEL_TIMEOUT and the
  // same-step retry that code already gets.
  if (input.code === "TIMEOUT" || input.code === "STREAM_IDLE_TIMEOUT") {
    return new ContentError(
      504,
      "MODEL_TIMEOUT",
      "LLM request timed out",
      metadata,
    );
  }

  // Per-attempt stream wall clock (STREAM_DURATION_MS): the model kept
  // producing, so this is a run-away response rather than a dead transport.
  if (input.code === "STREAM_DURATION_EXCEEDED") {
    return new ContentError(
      504,
      MODEL_STREAM_DURATION_EXCEEDED_CODE,
      "The model response ran too long and was stopped. Please try again.",
      metadata,
    );
  }

  if (input.code === "REASONING_BUDGET_EXCEEDED") {
    return new ContentError(
      502,
      MODEL_REASONING_BUDGET_EXCEEDED_CODE,
      "The model spent too long reasoning and the response was stopped. Please try again.",
      metadata,
    );
  }

  if (input.code === "OUTPUT_TRUNCATED") {
    return new ContentError(
      502,
      MODEL_OUTPUT_TRUNCATED_CODE,
      MODEL_OUTPUT_TRUNCATED_MESSAGE,
      metadata,
    );
  }

  if (input.code === "CONFIGURATION") {
    return new ContentError(
      503,
      "MODEL_CONFIGURATION_ERROR",
      "No model is available for this request. Ask an administrator to check the model provider and route configuration.",
      {
        ...metadata,
        details: { ...metadata.details, retryable: false },
        recoverable: false,
      },
    );
  }

  if (input.code === "AUTH") {
    return new ContentError(
      502,
      "MODEL_GATEWAY_AUTH_ERROR",
      "Model gateway authentication failed",
      metadata,
    );
  }

  return new ContentError(502, "MODEL_UPSTREAM_ERROR", message, metadata);
}

function gatewayContentErrorMetadata(input: {
  code: string;
  provider?: unknown;
  requestId?: unknown;
  retryable?: unknown;
  statusCode?: unknown;
}) {
  return {
    details: {
      gatewayCode: input.code,
      ...(typeof input.retryable === "boolean"
        ? { retryable: input.retryable }
        : {}),
      ...(typeof input.provider === "string"
        ? { provider: input.provider }
        : {}),
      ...(typeof input.requestId === "string"
        ? { requestId: input.requestId }
        : {}),
      ...(typeof input.statusCode === "number"
        ? { statusCode: input.statusCode }
        : {}),
    },
  };
}

export function sanitizeClientErrorMessage(value: string) {
  const text = value.trim();
  if (/^Failed query:/i.test(text)) {
    return "The request could not be saved. Please try again.";
  }
  if (
    /Error invoking tool/i.test(text) ||
    /Received tool input did not match expected schema/i.test(text) ||
    /\bkwargs\b/i.test(text) ||
    /Invalid input: expected .*received/i.test(text)
  ) {
    const toolName =
      text.match(/tool ['"]([^'"]+)['"]/i)?.[1] ??
      text.match(/\btool[=:]\s*([A-Za-z0-9_-]+)/i)?.[1];
    return toolName
      ? `${toolName} failed because the generated tool arguments were invalid. Please retry.`
      : "The generated tool arguments were invalid. Please retry.";
  }

  return text.length > 600 ? `${text.slice(0, 597).trimEnd()}...` : text;
}

/**
 * The ContentError the agent's backstop throws when it catches a `length`
 * finish with tool calls that the gateway facade did not: the same code,
 * message and metadata the gateway's `OUTPUT_TRUNCATED` maps to, so the
 * retry policy, run error code and lease retention cannot tell them apart.
 */
export function createModelOutputTruncatedContentError(
  input: { provider?: unknown; requestId?: unknown } = {},
): ContentError {
  return contentErrorFromGatewayCode({
    code: "OUTPUT_TRUNCATED",
    message: MODEL_OUTPUT_TRUNCATED_MESSAGE,
    retryable: true,
    provider: input.provider,
    requestId: input.requestId,
  });
}

export function toContentError(error: unknown): ContentError {
  // A ContentError is already the mapped shape; re-mapping it would classify
  // it by its (non-gateway) code and demote it to MODEL_UPSTREAM_ERROR.
  const contentError = findContentError(error);
  if (contentError) {
    return contentError;
  }

  const gatewayError = findGatewayError(error);
  if (gatewayError) {
    return contentErrorFromGatewayCode({
      code: gatewayError.code,
      message: gatewayError.message,
      provider: gatewayError.provider,
      requestId: gatewayError.requestId,
      retryable: gatewayError.retryable,
      statusCode: gatewayError.statusCode,
    });
  }

  const gatewayData = findGatewayErrorData(error);
  if (
    typeof gatewayData?.code === "string" &&
    typeof gatewayData.message === "string"
  ) {
    return contentErrorFromGatewayCode({
      code: gatewayData.code,
      message: gatewayData.message,
      provider: gatewayData.provider,
      requestId: gatewayData.requestId,
      retryable: gatewayData.retryable,
      statusCode: gatewayData.statusCode,
    });
  }

  const record = toRecord(error);
  const message =
    typeof record?.message === "string" && record.message.trim().length > 0
      ? sanitizeClientErrorMessage(record.message)
      : "LLM request failed";
  return new ContentError(502, "MODEL_UPSTREAM_ERROR", message);
}

export function isRetryableModelContentError(error: unknown): boolean {
  // Direct or wrapped (LangChain's MiddlewareError carries the thrown error as
  // its `cause`): the ContentError's own code and retry mark decide.
  const contentError = findContentError(error);
  if (contentError) {
    const details = toRecord(contentError.details);
    return (
      RETRYABLE_CONTENT_ERROR_CODES.has(contentError.code) &&
      details?.retryable === true
    );
  }

  const gatewayError = findGatewayError(error);
  if (gatewayError) {
    return gatewayError.retryable;
  }

  const gatewayData = findGatewayErrorData(error);
  return gatewayData?.retryable === true;
}
