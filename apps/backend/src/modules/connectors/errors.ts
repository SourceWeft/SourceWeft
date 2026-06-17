export type ConnectorErrorMetadata = {
  details?: Record<string, unknown>;
  sourceRef?: Record<string, unknown>;
  recoverable?: boolean;
};

export class ConnectorError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly sourceRef?: Record<string, unknown>;
  readonly recoverable?: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    detailsOrMetadata?: Record<string, unknown> | ConnectorErrorMetadata,
  ) {
    super(message);
    this.name = "ConnectorError";
    this.statusCode = statusCode;
    this.code = code;
    if (detailsOrMetadata && "sourceRef" in detailsOrMetadata) {
      const metadata = detailsOrMetadata as ConnectorErrorMetadata;
      this.details = metadata.details;
      this.sourceRef = metadata.sourceRef;
      this.recoverable = metadata.recoverable;
    } else {
      this.details = detailsOrMetadata as Record<string, unknown> | undefined;
    }
  }
}

export function isConnectorError(error: unknown): error is ConnectorError {
  return error instanceof ConnectorError;
}

function errorRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorMessages(value: unknown) {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = value;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error && current.message) {
      messages.push(current.message);
    } else if (typeof current === "string" && current) {
      messages.push(current);
    }
    current = errorRecord(current)?.cause;
  }
  return messages;
}

function errorCodes(value: unknown) {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = value;
  while (current && !seen.has(current)) {
    seen.add(current);
    const code = errorRecord(current)?.code;
    if (typeof code === "string" && code.length > 0) {
      codes.push(code);
    }
    current = errorRecord(current)?.cause;
  }
  return codes;
}

function connectorMigrationError(error: unknown) {
  const messages = errorMessages(error).join("\n");
  const lowerMessages = messages.toLowerCase();
  const codes = new Set(errorCodes(error));
  const missingColumn = codes.has("42703");
  const missingRelation = codes.has("42P01");

  if (
    missingColumn &&
    lowerMessages.includes("agent_tool_name") &&
    lowerMessages.includes("connector_action_runs")
  ) {
    return new ConnectorError(
      503,
      "CONNECTOR_MIGRATION_REQUIRED",
      "Connector action approval storage is not up to date. Run backend migrations, then restart the worker.",
      { migration: "0003_agent_tool_trust_rules" },
    );
  }

  if (
    (missingRelation || lowerMessages.includes("does not exist")) &&
    lowerMessages.includes("agent_tool_trust_rules")
  ) {
    return new ConnectorError(
      503,
      "CONNECTOR_MIGRATION_REQUIRED",
      "Agent tool trust-rule storage is not ready. Run backend migrations, then restart the worker.",
      { migration: "0003_agent_tool_trust_rules" },
    );
  }

  if (
    (missingRelation || lowerMessages.includes("does not exist")) &&
    lowerMessages.includes("connector_action_runs")
  ) {
    return new ConnectorError(
      503,
      "CONNECTOR_MIGRATION_REQUIRED",
      "Connector action-run storage is not ready. Run backend migrations, then restart the worker.",
      { migration: "0001_baseline" },
    );
  }

  return null;
}

function isPackageConnectorError(
  error: unknown,
): error is { statusCode: number; code: string; message: string; details?: Record<string, unknown> } {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as Record<string, unknown>).statusCode === "number" &&
    typeof (error as Record<string, unknown>).code === "string" &&
    typeof (error as Record<string, unknown>).message === "string"
  );
}

export function toConnectorError(error: unknown): ConnectorError {
  if (isConnectorError(error)) {
    return error;
  }

  if (isPackageConnectorError(error)) {
    return new ConnectorError(
      error.statusCode,
      error.code,
      error.message,
      error.details,
    );
  }

  const migrationError = connectorMigrationError(error);
  if (migrationError) {
    return migrationError;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ConnectorError(
    500,
    "CONNECTOR_OPERATION_FAILED",
    message || "Connector operation failed",
  );
}
