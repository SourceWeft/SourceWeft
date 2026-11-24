import { logger } from "../../shared/logger";
import {
  isConnectorError,
  isPackageConnectorError,
  toConnectorError,
  type ConnectorError,
} from "./errors";

export type ConnectorToolErrorPayload = {
  type: "connector_tool_error";
  code: string;
  message: string;
  statusCode: number;
  recoverable?: boolean;
  retryAfterSeconds?: number;
};

const MAX_PACKAGE_ERROR_MESSAGE_LENGTH = 500;

// Connector packages throw their own structured errors (a numeric
// `statusCode`, a string `code`, a string `message`, optional `details`).
// A package's message is forwarded to the caller as-is, after stripping
// control characters and bounding its length. It is not always a fixed string
// the connector author wrote: some adapters (for example Notion) build it from
// the provider's own answer, so each adapter owns keeping tokens, headers and
// response bodies out of the message it throws.
function sanitizePackageErrorMessage(message: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = message.replace(/[\x00-\x1F\x7F]/g, " ").trim();
  if (cleaned.length <= MAX_PACKAGE_ERROR_MESSAGE_LENGTH) {
    return cleaned;
  }
  return `${cleaned.slice(0, MAX_PACKAGE_ERROR_MESSAGE_LENGTH - 1)}…`;
}

const MAX_RETRY_AFTER_SECONDS = 86400;

function resolveRetryAfterSeconds(
  details: Record<string, unknown> | undefined,
): number | undefined {
  const raw = details?.retryAfterSeconds;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) {
    return undefined;
  }
  return Math.min(Math.ceil(raw), MAX_RETRY_AFTER_SECONDS);
}

function errorLogFields(error: unknown, omitResponseContent: boolean) {
  const errorName = error instanceof Error ? error.name : typeof error;
  // A read action's error can carry the provider's own response text in its
  // `message` (and therefore its `stack`), so when the omit rule applies the
  // error-level line records only the error's name, alongside the `code` and
  // `statusCode` the caller already logs.
  if (omitResponseContent) {
    return { errorName };
  }
  if (error instanceof Error) {
    return {
      error: error.message,
      errorName: error.name,
      stack: error.stack,
    };
  }
  return {
    error: String(error),
    errorName,
  };
}

function safeToolErrorMessage(input: {
  originalError: unknown;
  connectorError: ConnectorError;
}) {
  if (input.connectorError.code === "CONNECTOR_ACTION_NOT_APPROVED") {
    return "Approved action was not found for this resumed tool call. Please retry the confirmation.";
  }
  if (
    isConnectorError(input.originalError) ||
    input.connectorError.code === "CONNECTOR_MIGRATION_REQUIRED"
  ) {
    return input.connectorError.message;
  }
  if (isPackageConnectorError(input.originalError)) {
    const sanitized = sanitizePackageErrorMessage(input.connectorError.message);
    if (sanitized) {
      return sanitized;
    }
  }
  return "Connector tool failed. Check backend logs for details.";
}

export async function connectorToolResult<T>(
  operation: () => Promise<T>,
  context: {
    connectorType?: string;
    toolName?: string;
    /** When true (Gmail, or a `connector_read` action), the error-level log
     * drops the error message, stack and details so a provider's response text
     * cannot leak through it. Mirrors the debug log's omit rule. */
    omitResponseContent?: boolean;
  } = {},
): Promise<T | ConnectorToolErrorPayload> {
  const { omitResponseContent, ...logContext } = context;
  try {
    return await operation();
  } catch (error) {
    const connectorError = toConnectorError(error);
    logger.error("Connector agent tool failed", {
      ...logContext,
      code: connectorError.code,
      statusCode: connectorError.statusCode,
      ...errorLogFields(error, omitResponseContent === true),
    });
    const retryAfterSeconds = resolveRetryAfterSeconds(connectorError.details);
    return {
      type: "connector_tool_error",
      code: connectorError.code,
      message: safeToolErrorMessage({
        originalError: error,
        connectorError,
      }),
      statusCode: connectorError.statusCode,
      ...(connectorError.recoverable ? { recoverable: true } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }
}
