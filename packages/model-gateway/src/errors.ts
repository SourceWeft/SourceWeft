import type { GatewayErrorCode, GatewayErrorData } from "./types";
import { isRecord } from "./utils/object";

const RETRYABLE_CODES: ReadonlySet<GatewayErrorCode> = new Set([
  "TIMEOUT",
  "RATE_LIMIT",
  "UPSTREAM",
]);

export class ModelGatewayError extends Error {
  readonly code: GatewayErrorCode;

  readonly retryable: boolean;

  readonly statusCode?: number;

  readonly provider?: string;

  readonly requestId?: string;

  readonly metadata?: Record<string, unknown>;

  constructor(input: {
    code: GatewayErrorCode;
    message: string;
    retryable?: boolean;
    statusCode?: number;
    provider?: string;
    requestId?: string;
    metadata?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = "ModelGatewayError";
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

  static isInstance(value: unknown): value is ModelGatewayError {
    return value instanceof ModelGatewayError;
  }
}

function mapStatusCodeToErrorCode(statusCode: number): GatewayErrorCode {
  if (statusCode === 401 || statusCode === 403) {
    return "AUTH";
  }
  if (statusCode === 402) {
    return "QUOTA";
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

export function createHttpGatewayError(input: {
  statusCode: number;
  body?: unknown;
  requestId?: string;
}): ModelGatewayError {
  const { statusCode, body, requestId } = input;
  const code = mapStatusCodeToErrorCode(statusCode);
  const fallbackMessage = `Model gateway request failed with status ${statusCode}`;
  const message = extractMessageFromBody(body, fallbackMessage);

  return new ModelGatewayError({
    code,
    message,
    statusCode,
    provider: extractProviderFromBody(body),
    requestId,
    metadata: isRecord(body) ? body : undefined,
  });
}

export function normalizeGatewayError(error: unknown): ModelGatewayError {
  if (ModelGatewayError.isInstance(error)) {
    return error;
  }

  if (
    isRecord(error) &&
    (error.name === "AbortError" || error.name === "TimeoutError") &&
    typeof error.message === "string"
  ) {
    return new ModelGatewayError({
      code: "TIMEOUT",
      message: error.message || "Model gateway request timed out",
      retryable: true,
      cause: error,
    });
  }

  if (isRecord(error) && typeof error.message === "string") {
    return new ModelGatewayError({
      code: "UPSTREAM",
      message: error.message,
      retryable: true,
      cause: error,
    });
  }

  return new ModelGatewayError({
    code: "UNKNOWN",
    message: "Unknown model gateway error",
    retryable: false,
    cause: error,
  });
}

export function isRetryableError(error: unknown): boolean {
  return normalizeGatewayError(error).retryable;
}

export function toGatewayErrorData(error: unknown): GatewayErrorData {
  const normalized = normalizeGatewayError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
    statusCode: normalized.statusCode,
    provider: normalized.provider,
    requestId: normalized.requestId,
  };
}
