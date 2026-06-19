import { ModelGatewayError } from "@sourceweft/model-gateway";
import { ContentError } from "./errors";

const RETRYABLE_CONTENT_ERROR_CODES = new Set([
  "MODEL_TIMEOUT",
  "MODEL_RATE_LIMITED",
  "MODEL_UPSTREAM_ERROR",
]);

function toRecord(value: unknown) {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function findGatewayError(error: unknown, seen = new Set<unknown>()): ModelGatewayError | null {
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

function findGatewayErrorData(error: unknown, seen = new Set<unknown>()): {
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

  return findGatewayErrorData(record.cause, seen) ?? findGatewayErrorData(record.error, seen);
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

  if (input.code === "TIMEOUT") {
    return new ContentError(504, "MODEL_TIMEOUT", "LLM request timed out", metadata);
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
      ...(typeof input.provider === "string" ? { provider: input.provider } : {}),
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

export function toContentError(error: unknown): ContentError {
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
  if (typeof gatewayData?.code === "string" && typeof gatewayData.message === "string") {
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
  if (error instanceof ContentError) {
    const details = toRecord(error.details);
    return (
      RETRYABLE_CONTENT_ERROR_CODES.has(error.code) &&
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
