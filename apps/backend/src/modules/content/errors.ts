export class ContentError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "ContentError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function isContentError(error: unknown): error is ContentError {
  return error instanceof ContentError;
}
