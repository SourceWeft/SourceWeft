export type GhostErrorCode =
  | "SITE_URL_INVALID"
  | "SITE_UNREACHABLE"
  | "NOT_A_GHOST_SITE"
  | "BAD_CREDENTIALS"
  | "BLOCKED_ENDPOINT"
  | "LINK_INVALID"
  | "RATE_LIMITED"
  | "BAD_RESPONSE"
  | "TOO_LARGE"
  | "CONFIG_INVALID";

/**
 * A fixed English message per code. It never contains the site address, the
 * Content API key, an id or a response body: nothing from the site or an
 * underlying error is forwarded, so an error can be surfaced to a member as-is.
 */
export const GHOST_ERROR_MESSAGES: Record<GhostErrorCode, string> = {
  SITE_URL_INVALID: "The site address is not a valid public Ghost address.",
  SITE_UNREACHABLE: "The Ghost site could not be reached.",
  NOT_A_GHOST_SITE:
    "The address does not belong to a Ghost site with a Content API.",
  BAD_CREDENTIALS: "The Ghost Content API key was not accepted.",
  BLOCKED_ENDPOINT: "The Ghost site address is not allowed.",
  LINK_INVALID: "The Ghost site reported a content link that is not valid.",
  RATE_LIMITED: "The Ghost site is limiting requests. Try again later.",
  BAD_RESPONSE: "The Ghost site returned an unexpected response.",
  TOO_LARGE: "The Ghost content is too large to read in one sync.",
  CONFIG_INVALID: "The Ghost connector settings are not valid.",
};

const GHOST_ERROR_STATUS: Record<GhostErrorCode, number> = {
  SITE_URL_INVALID: 400,
  SITE_UNREACHABLE: 502,
  NOT_A_GHOST_SITE: 422,
  BAD_CREDENTIALS: 401,
  BLOCKED_ENDPOINT: 422,
  LINK_INVALID: 502,
  RATE_LIMITED: 429,
  BAD_RESPONSE: 502,
  TOO_LARGE: 422,
  CONFIG_INVALID: 400,
};

/**
 * Error thrown by this package's Ghost layer. `apps/backend` copies `status`,
 * `code` and `message` onto a `ConnectorError`. The message is one of the fixed
 * strings above: it never carries the site address, the key, an id or a
 * response body, and no `cause` is ever set.
 */
export class GhostError extends Error {
  readonly status: number;
  readonly code: GhostErrorCode;

  constructor(code: GhostErrorCode) {
    super(GHOST_ERROR_MESSAGES[code]);
    this.name = "GhostError";
    this.status = GHOST_ERROR_STATUS[code];
    this.code = code;
  }
}

export function isGhostError(value: unknown): value is GhostError {
  return value instanceof GhostError;
}
