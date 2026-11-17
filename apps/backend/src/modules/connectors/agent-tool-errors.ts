import { logger } from "../../shared/logger";
import {
  isConnectorError,
  toConnectorError,
  type ConnectorError,
} from "./errors";

export type ConnectorToolErrorPayload = {
  type: "connector_tool_error";
  code: string;
  message: string;
  statusCode: number;
  recoverable?: boolean;
};

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
    return {
      type: "connector_tool_error",
      code: connectorError.code,
      message: safeToolErrorMessage({
        originalError: error,
        connectorError,
      }),
      statusCode: connectorError.statusCode,
      ...(connectorError.recoverable ? { recoverable: true } : {}),
    };
  }
}
