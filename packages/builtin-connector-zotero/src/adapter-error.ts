import { ZoteroError } from "./errors";

/**
 * An error shaped like the platform's `ConnectorError` (`statusCode`, `code`,
 * `message`), used at the adapter boundary. A rejected key becomes a 422
 * `ZOTERO_REAUTH_REQUIRED` (the `_REAUTH_REQUIRED` suffix is what the platform
 * recognises as a reconnect condition), never a 401 that could trip a
 * sign-out. Messages are fixed and never echo the request, the API key, the
 * library id or a URL.
 */
export class ZoteroAdapterError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "ZoteroAdapterError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** The fixed 400 for an action request the adapter cannot accept. */
export function invalidRequestError(): ZoteroAdapterError {
  return new ZoteroAdapterError(
    400,
    "ZOTERO_INVALID_REQUEST",
    "The Zotero action request is not valid.",
  );
}

/**
 * Crosses a Zotero-layer failure over the adapter boundary: a {@link ZoteroError}
 * keeps its own fixed status, code and message (reauth is already a 422
 * `ZOTERO_REAUTH_REQUIRED`); anything else is rethrown untouched. Always throws.
 */
export function toAdapterError(error: unknown): never {
  if (error instanceof ZoteroError) {
    throw new ZoteroAdapterError(error.statusCode, error.code, error.message);
  }
  throw error;
}
