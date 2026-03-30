import type { UnifiedError, UnifiedErrorCode } from "./types";
import { isRecord } from "./utils/object";

const RETRYABLE_CODES: ReadonlySet<UnifiedErrorCode> = new Set([
  "TIMEOUT",
  "RATE_LIMIT",
  "UPSTREAM",
]);

export class LiteLLMError extends Error {
  readonly code: UnifiedErrorCode;

  readonly retryable: boolean;

  readonly statusCode?: number;

  readonly provider?: string;

  readonly requestId?: string;

  readonly metadata?: Record<string, unknown>;

  constructor(input: {
    code: UnifiedErrorCode;
    message: string;
    retryable?: boolean;
    statusCode?: number;
    provider?: string;
    requestId?: string;
    metadata?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = "LiteLLMError";
    this.code = input.code;
    this.retryable = input.retryable ?? RETRYABLE_CODES.has(input.code);
    this.statusCode = input.statusCode;
    this.provider = input.provider;
    this.requestId = input.requestId;
    this.metadata = input.metadata;
    if (input.cause !== undefined) {
      (this as { cause?: unknown }).cause = input.cause;
    }
  }

  static isInstance(value: unknown): value is LiteLLMError {
    return value instanceof LiteLLMError;
  }
}

function mapStatusCodeToErrorCode(statusCode: number): UnifiedErrorCode {
  if (statusCode === 401 || statusCode === 403) {
    return "AUTH";
  }
  if (statusCode === 429) {
    return "RATE_LIMIT";
  }
  if (statusCode >= 400 && statusCode < 500) {
    return "BAD_REQUEST";
  }
  if (statusCode >= 500) {
    return "UPSTREAM";
  }
  return "UNKNOWN";
}

function extractMessageFromBody(body: unknown, fallback: string): string {
  if (!isRecord(body)) {
    return fallback;
  }

  const bodyMessage =
    (isRecord(body.error) &&
      typeof body.error.message === "string" &&
      body.error.message) ||
    (typeof body.message === "string" && body.message) ||
    fallback;

  return bodyMessage;
}

function extractProviderFromBody(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  if (typeof body.provider === "string" && body.provider.length > 0) {
    return body.provider;
  }

  if (isRecord(body.error) && typeof body.error.type === "string") {
    return body.error.type;
  }

  return undefined;
}

export function createHttpLiteLLMError(input: {
  statusCode: number;
  body?: unknown;
  requestId?: string;
}): LiteLLMError {
  const { statusCode, body, requestId } = input;
  const code = mapStatusCodeToErrorCode(statusCode);
  const fallbackMessage = `LiteLLM request failed with status ${statusCode}`;
  const message = extractMessageFromBody(body, fallbackMessage);

  return new LiteLLMError({
    code,
    message,
    statusCode,
    provider: extractProviderFromBody(body),
    requestId,
    metadata: isRecord(body) ? body : undefined,
  });
}

export function normalizeLiteLLMError(error: unknown): LiteLLMError {
  if (LiteLLMError.isInstance(error)) {
    return error;
  }

  if (
    isRecord(error) &&
    error.name === "AbortError" &&
    typeof error.message === "string"
  ) {
    return new LiteLLMError({
      code: "TIMEOUT",
      message: error.message || "LiteLLM request timed out",
      retryable: true,
      cause: error,
    });
  }

  if (isRecord(error) && typeof error.message === "string") {
    return new LiteLLMError({
      code: "UPSTREAM",
      message: error.message,
      retryable: true,
      cause: error,
    });
  }

  return new LiteLLMError({
    code: "UNKNOWN",
    message: "Unknown LiteLLM error",
    retryable: false,
    cause: error,
  });
}

export function isRetryableError(error: unknown): boolean {
  return normalizeLiteLLMError(error).retryable;
}

export function toUnifiedError(error: unknown): UnifiedError {
  const normalized = normalizeLiteLLMError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
    statusCode: normalized.statusCode,
    provider: normalized.provider,
    requestId: normalized.requestId,
  };
}
