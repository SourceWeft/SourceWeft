import { DiscourseError } from "./errors";

/**
 * An error shaped like the platform's `ConnectorError` (`statusCode`, `code`,
 * `message`), used at the adapter boundary. Messages are fixed and never echo
 * the request, the forum address or anything a forum sent.
 */
export class DiscourseAdapterError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "DiscourseAdapterError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** The fixed 400 for an action request the adapter cannot accept. */
export function invalidRequestError(): DiscourseAdapterError {
  return new DiscourseAdapterError(
    400,
    "DISCOURSE_INVALID_REQUEST",
    "The Discourse action request is not valid.",
  );
}

/**
 * Crosses a Discourse-layer failure over the adapter boundary: a
 * {@link DiscourseError} keeps its own fixed status, code and message (no
 * cause is carried); anything else (an item skip, a programming error) is
 * rethrown untouched. Always throws.
 */
export function toAdapterError(error: unknown): never {
  if (error instanceof DiscourseError) {
    throw new DiscourseAdapterError(
      error.statusCode,
      error.code,
      error.message,
    );
  }
  throw error;
}
