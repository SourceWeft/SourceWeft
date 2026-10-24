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

/** A market admin blocked the member on this server. */
export function claimBlockedError(): McpClaimError {
  return new McpClaimError(
    403,
    "MCP_CLAIM_BLOCKED",
    "A market admin revoked your claim on this server; write to support if you believe that was wrong",
  );
}

/** Corrections are a verified owner's to make. */
export function claimRequiredError(): McpClaimError {
  return new McpClaimError(
    403,
    "MCP_CLAIM_REQUIRED",
    "Only a verified owner of this server may change its listing",
  );
}
