export class McpError extends Error {
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
    this.name = "McpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function isMcpError(error: unknown): error is McpError {
  return error instanceof McpError;
}
