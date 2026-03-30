import type { LiteLLMLogger } from "../types";

const SENSITIVE_KEY_PATTERN = /(authorization|api[_-]?key|token|secret)/i;

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= 8) {
      return "***";
    }
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (typeof value === "object" && value !== null) {
    return redactRecord(value as Record<string, unknown>);
  }

  return value;
}

export function redactRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = "***";
    } else {
      output[key] = redactValue(value);
    }
  }
  return output;
}

export function logRequestStart(
  logger: LiteLLMLogger,
  message: string,
  data?: Record<string, unknown>,
) {
  logger.debug?.(message, data ? redactRecord(data) : undefined);
}

export function logRequestRetry(
  logger: LiteLLMLogger,
  message: string,
  data?: Record<string, unknown>,
) {
  logger.warn?.(message, data ? redactRecord(data) : undefined);
}

export function logRequestSuccess(
  logger: LiteLLMLogger,
  message: string,
  data?: Record<string, unknown>,
) {
  logger.info?.(message, data ? redactRecord(data) : undefined);
}

export function logRequestFailure(
  logger: LiteLLMLogger,
  message: string,
  data?: Record<string, unknown>,
) {
  logger.error?.(message, data ? redactRecord(data) : undefined);
}
