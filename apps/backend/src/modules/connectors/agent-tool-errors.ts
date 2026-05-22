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
};

function errorLogFields(error: unknown) {
  if (error instanceof Error) {
    return {
      error: error.message,
      errorName: error.name,
      stack: error.stack,
    };
  }
  return {
    error: String(error),
    errorName: typeof error,
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
  } = {},
): Promise<T | ConnectorToolErrorPayload> {
  try {
    return await operation();
  } catch (error) {
    const connectorError = toConnectorError(error);
    logger.error("Connector agent tool failed", {
      ...context,
      code: connectorError.code,
      statusCode: connectorError.statusCode,
      ...errorLogFields(error),
    });
    return {
      type: "connector_tool_error",
      code: connectorError.code,
      message: safeToolErrorMessage({
        originalError: error,
        connectorError,
      }),
      statusCode: connectorError.statusCode,
    };
  }
}
