export class ConnectorError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConnectorError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function isConnectorError(error: unknown): error is ConnectorError {
  return error instanceof ConnectorError;
}

export function toConnectorError(error: unknown): ConnectorError {
  if (isConnectorError(error)) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ConnectorError(
    500,
    "CONNECTOR_OPERATION_FAILED",
    message || "Connector operation failed",
  );
}
