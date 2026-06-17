/**
 * Serializable error shape thrown by connector adapter packages.
 * The backend wraps these into its own ConnectorError class at the
 * orchestration boundary so packages never depend on the backend runtime.
 */
export type ConnectorErrorShape = {
  statusCode: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

/** Type guard: checks whether an unknown error satisfies ConnectorErrorShape. */
export function isConnectorErrorShape(
  error: unknown,
): error is ConnectorErrorShape {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as Record<string, unknown>).statusCode === "number" &&
    typeof (error as Record<string, unknown>).code === "string" &&
    typeof (error as Record<string, unknown>).message === "string"
  );
}
