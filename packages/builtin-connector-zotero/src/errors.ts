export type ZoteroErrorCode =
  | "ZOTERO_REAUTH_REQUIRED"
  | "ZOTERO_KEY_INSUFFICIENT_ACCESS"
  | "ZOTERO_LIBRARY_NOT_FOUND"
  | "ZOTERO_RATE_LIMITED"
  | "ZOTERO_UNAVAILABLE"
  | "ZOTERO_BLOCKED_ENDPOINT"
  | "ZOTERO_BAD_RESPONSE"
  | "ZOTERO_TOO_LARGE"
  | "ZOTERO_CONFIG_INVALID";

const FAILURES: Record<
  ZoteroErrorCode,
  { statusCode: number; message: string }
> = {
  ZOTERO_REAUTH_REQUIRED: {
    statusCode: 422,
    message: "Zotero no longer accepts the saved access. Reconnect Zotero.",
  },
  ZOTERO_KEY_INSUFFICIENT_ACCESS: {
    statusCode: 422,
    message:
      "The Zotero access you granted does not allow reading this library.",
  },
  ZOTERO_LIBRARY_NOT_FOUND: {
    statusCode: 404,
    message: "The Zotero library was not found.",
  },
  ZOTERO_RATE_LIMITED: {
    statusCode: 429,
    message: "Zotero is limiting requests. Try again later.",
  },
  ZOTERO_UNAVAILABLE: {
    statusCode: 502,
    message: "Zotero could not be reached.",
  },
  ZOTERO_BLOCKED_ENDPOINT: {
    statusCode: 422,
    message: "The Zotero server address is not allowed.",
  },
  ZOTERO_BAD_RESPONSE: {
    statusCode: 502,
    message: "Zotero returned an unexpected response.",
  },
  ZOTERO_TOO_LARGE: {
    statusCode: 422,
    message: "The Zotero library is too large to read.",
  },
  ZOTERO_CONFIG_INVALID: {
    statusCode: 400,
    message: "The Zotero library settings are not valid.",
  },
};

/**
 * Error thrown by this package's Zotero layer. `apps/backend` copies
 * `statusCode`, `code` and `message` onto a `ConnectorError`. The message is a
 * fixed English string per code: it never contains the API key, the library
 * id, a URL, a response body or an underlying error's text, and no `cause` is
 * ever set.
 */
export class ZoteroError extends Error {
  readonly statusCode: number;
  readonly code: ZoteroErrorCode;

  constructor(code: ZoteroErrorCode) {
    super(FAILURES[code].message);
    this.name = "ZoteroError";
    this.statusCode = FAILURES[code].statusCode;
    this.code = code;
  }
}
