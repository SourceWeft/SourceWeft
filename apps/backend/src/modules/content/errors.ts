export class ContentError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  readonly recoverable?: boolean;
  readonly sourceRef?: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    metadata: {
      details?: unknown;
      recoverable?: boolean;
      sourceRef?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "ContentError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = metadata.details;
    this.recoverable = metadata.recoverable;
    this.sourceRef = metadata.sourceRef;
  }
}

export function isContentError(error: unknown): error is ContentError {
  return error instanceof ContentError;
}
