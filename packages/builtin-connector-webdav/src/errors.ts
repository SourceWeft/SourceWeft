export type WebDavErrorCode =
  | "WEBDAV_UNAUTHORIZED"
  | "WEBDAV_FORBIDDEN"
  | "WEBDAV_NOT_FOUND"
  | "WEBDAV_UNREACHABLE"
  | "WEBDAV_BLOCKED_ENDPOINT"
  | "WEBDAV_BAD_RESPONSE"
  | "WEBDAV_TOO_LARGE"
  | "WEBDAV_ENDPOINT_INVALID"
  | "WEBDAV_PATH_INVALID";

const FAILURES: Record<
  WebDavErrorCode,
  { statusCode: number; message: string }
> = {
  WEBDAV_UNAUTHORIZED: {
    statusCode: 401,
    message: "The WebDAV server rejected the username or password.",
  },
  WEBDAV_FORBIDDEN: {
    statusCode: 403,
    message: "The WebDAV account is not allowed to read this location.",
  },
  WEBDAV_NOT_FOUND: {
    statusCode: 404,
    message: "The WebDAV location was not found.",
  },
  WEBDAV_UNREACHABLE: {
    statusCode: 502,
    message: "The WebDAV server could not be reached.",
  },
  WEBDAV_BLOCKED_ENDPOINT: {
    statusCode: 422,
    message: "The WebDAV server address is not allowed.",
  },
  WEBDAV_BAD_RESPONSE: {
    statusCode: 502,
    message: "The WebDAV server returned an unexpected response.",
  },
  WEBDAV_TOO_LARGE: {
    statusCode: 422,
    message: "The WebDAV file is too large.",
  },
  WEBDAV_ENDPOINT_INVALID: {
    statusCode: 400,
    message: "The WebDAV address is not valid.",
  },
  WEBDAV_PATH_INVALID: {
    statusCode: 400,
    message: "The WebDAV path is not valid.",
  },
};

/**
 * Error thrown by this package's WebDAV layer. `apps/backend` copies
 * `statusCode`, `code` and `message` onto a `ConnectorError`. The message is a
 * fixed English string per code: it never contains the endpoint, a path, the
 * credential, a response body or an underlying error's text, and no `cause` is
 * ever set.
 */
export class WebDavError extends Error {
  readonly statusCode: number;
  readonly code: WebDavErrorCode;

  constructor(code: WebDavErrorCode) {
    super(FAILURES[code].message);
    this.name = "WebDavError";
    this.statusCode = FAILURES[code].statusCode;
    this.code = code;
  }
}
