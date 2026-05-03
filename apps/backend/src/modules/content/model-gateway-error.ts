import { ModelGatewayError } from "@sourceweft/model-gateway";
import { ContentError } from "./errors";

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
}) {
  if (input.code === "BAD_REQUEST") {
    return new ContentError(400, "MODEL_REQUEST_INVALID", input.message);
  }

  if (input.code === "RATE_LIMIT") {
    return new ContentError(
      429,
      "MODEL_RATE_LIMITED",
      "LLM provider rate limit reached",
    );
  }

  if (input.code === "TIMEOUT") {
    return new ContentError(504, "MODEL_TIMEOUT", "LLM request timed out");
  }

  if (input.code === "AUTH") {
    return new ContentError(
      502,
      "MODEL_GATEWAY_AUTH_ERROR",
      "Model gateway authentication failed",
    );
  }

  return new ContentError(502, "MODEL_UPSTREAM_ERROR", input.message);
}

export function toContentServiceError(error: unknown): ContentError {
  const gatewayError = findGatewayError(error);
  if (gatewayError) {
    return contentErrorFromGatewayCode({
      code: gatewayError.code,
      message: gatewayError.message,
    });
  }

  const gatewayData = findGatewayErrorData(error);
  if (typeof gatewayData?.code === "string" && typeof gatewayData.message === "string") {
    return contentErrorFromGatewayCode({
      code: gatewayData.code,
      message: gatewayData.message,
    });
  }

  const record = toRecord(error);
  const message = typeof record?.message === "string" && record.message.trim().length > 0
    ? record.message
    : "LLM request failed";
  return new ContentError(502, "MODEL_UPSTREAM_ERROR", message);
}
