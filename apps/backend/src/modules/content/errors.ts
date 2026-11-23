export class ContentError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  /**
   * When true, `details` is part of the public error body API clients see.
   * Off by default: most details (gateway provider, request id) are
   * diagnostics for logs, not for the client.
   */
  readonly exposeDetails?: boolean;
  readonly recoverable?: boolean;
  readonly sourceRef?: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    metadata: {
      details?: unknown;
      exposeDetails?: boolean;
      recoverable?: boolean;
      sourceRef?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "ContentError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = metadata.details;
    this.exposeDetails = metadata.exposeDetails;
    this.recoverable = metadata.recoverable;
    this.sourceRef = metadata.sourceRef;
  }
}

export function isContentError(error: unknown): error is ContentError {
  return error instanceof ContentError;
}
