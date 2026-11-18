/**
 * A refusal a client can act on. `code` is stable and `details` is meant for
 * the client (which limit, when to retry, why a rule is invalid), so both are
 * returned in the API response.
 */
export class AgentTaskError extends Error {
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
    this.name = "AgentTaskError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function isAgentTaskError(error: unknown): error is AgentTaskError {
  return error instanceof AgentTaskError;
}
