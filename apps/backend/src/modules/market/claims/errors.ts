/**
 * What a claim or correction request is refused with. The market module
 * stays free of sibling modules, so this is its own error type; the API layer
 * maps it to a response (`toApiError`).
 */
export class McpClaimError extends Error {
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
    this.name = "McpClaimError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function isMcpClaimError(error: unknown): error is McpClaimError {
  return error instanceof McpClaimError;
}
