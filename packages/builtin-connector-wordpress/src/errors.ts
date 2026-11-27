export type WordPressErrorCode =
  | "SITE_URL_INVALID"
  | "SITE_UNREACHABLE"
  | "NOT_A_WORDPRESS_SITE"
  | "REST_DISABLED"
  | "LOGIN_REQUIRED"
  | "BAD_CREDENTIALS"
  | "INSUFFICIENT_PERMISSION"
  | "BLOCKED_ENDPOINT"
  | "LINK_HOST_MISMATCH"
  | "RATE_LIMITED"
  | "BAD_RESPONSE"
  | "TOO_LARGE"
  | "CONFIG_INVALID";

/**
 * A fixed English message per code. It never contains the site address, a
 * credential, an id or a response body: nothing from the site or an underlying
 * error is forwarded, so an error can be surfaced to a member as-is.
 */
export const WORDPRESS_ERROR_MESSAGES: Record<WordPressErrorCode, string> = {
  SITE_URL_INVALID: "The site address is not a valid public WordPress address.",
  SITE_UNREACHABLE: "The WordPress site could not be reached.",
  NOT_A_WORDPRESS_SITE: "The address does not belong to a WordPress site.",
  REST_DISABLED: "The WordPress REST API is turned off on this site.",
  LOGIN_REQUIRED:
    "This WordPress content requires signing in, which the public connector does not do.",
  BAD_CREDENTIALS:
    "The WordPress username or application password was not accepted.",
  INSUFFICIENT_PERMISSION:
    "The WordPress account is not allowed to read the requested content.",
  BLOCKED_ENDPOINT: "The WordPress site address is not allowed.",
  LINK_HOST_MISMATCH:
    "The WordPress site reports content links under a different address.",
  RATE_LIMITED: "The WordPress site is limiting requests. Try again later.",
  BAD_RESPONSE: "The WordPress site returned an unexpected response.",
  TOO_LARGE: "The WordPress content is too large to read in one sync.",
  CONFIG_INVALID: "The WordPress connector settings are not valid.",
};

const WORDPRESS_ERROR_STATUS: Record<WordPressErrorCode, number> = {
  SITE_URL_INVALID: 400,
  SITE_UNREACHABLE: 502,
  NOT_A_WORDPRESS_SITE: 422,
  REST_DISABLED: 422,
  LOGIN_REQUIRED: 422,
  BAD_CREDENTIALS: 401,
  INSUFFICIENT_PERMISSION: 422,
  BLOCKED_ENDPOINT: 422,
  LINK_HOST_MISMATCH: 502,
  RATE_LIMITED: 429,
  BAD_RESPONSE: 502,
  TOO_LARGE: 422,
  CONFIG_INVALID: 400,
};

/**
 * The WordPress REST error codes this package recognises. This is a closed
 * enum: a response `code` outside it is never recorded, so an error never
 * carries arbitrary response text. Tasks 4/5/7 read {@link WordPressError.restCode}
 * to tell, for example, `rest_forbidden_status` (an unauthorised `status`
 * filter) apart from a plain `rest_invalid_param`.
 */
export type WordPressRestCode =
  | "rest_forbidden_status"
  | "rest_invalid_param"
  | "rest_cannot_view"
  | "rest_forbidden"
  | "rest_login_required"
  | "incorrect_password"
  | "invalid_username"
  | "rest_not_logged_in"
  | "rest_no_route"
  | "rest_user_cannot_view";

const WORDPRESS_REST_CODES: ReadonlySet<string> = new Set<WordPressRestCode>([
  "rest_forbidden_status",
  "rest_invalid_param",
  "rest_cannot_view",
  "rest_forbidden",
  "rest_login_required",
  "incorrect_password",
  "invalid_username",
  "rest_not_logged_in",
  "rest_no_route",
  "rest_user_cannot_view",
]);

/** The value as a {@link WordPressRestCode}, or `undefined` if it is not one. */
export function asWordPressRestCode(
  value: unknown,
): WordPressRestCode | undefined {
  return typeof value === "string" && WORDPRESS_REST_CODES.has(value)
    ? (value as WordPressRestCode)
    : undefined;
}

/**
 * Error thrown by this package's WordPress layer. `apps/backend` copies
 * `status`, `code` and `message` onto a `ConnectorError`. The message is one of
 * the fixed strings above: it never carries the site address, a credential, an
 * id or a response body, and no `cause` is ever set. The application password
 * in particular never reaches an error. `restCode`, when set, is a recognised
 * {@link WordPressRestCode} (a plain enum value, never response text): the
 * client records it for a 400/401/403/404 so later tasks can map a more precise
 * outcome without re-reading the body.
 */
export class WordPressError extends Error {
  readonly status: number;
  readonly code: WordPressErrorCode;
  readonly restCode?: WordPressRestCode;

  constructor(code: WordPressErrorCode, restCode?: WordPressRestCode) {
    super(WORDPRESS_ERROR_MESSAGES[code]);
    this.name = "WordPressError";
    this.status = WORDPRESS_ERROR_STATUS[code];
    this.code = code;
    if (restCode !== undefined) this.restCode = restCode;
  }
}

export function isWordPressError(value: unknown): value is WordPressError {
  return value instanceof WordPressError;
}
