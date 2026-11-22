/**
 * A refusal a client can act on. `code` is stable and `details` is meant for
 * the client (which ticket, which version was expected), so both are
 * returned in the API response.
 */
export class AssistantError extends Error {
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
    this.name = "AssistantError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function isAssistantError(error: unknown): error is AssistantError {
  return error instanceof AssistantError;
}
