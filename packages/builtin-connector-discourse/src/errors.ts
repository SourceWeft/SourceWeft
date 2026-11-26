export type DiscourseErrorCode =
  | "DISCOURSE_FORUM_URL_INVALID"
  | "DISCOURSE_FORUM_UNREACHABLE"
  | "DISCOURSE_NOT_A_DISCOURSE_SITE"
  | "DISCOURSE_LOGIN_REQUIRED"
  | "DISCOURSE_BLOCKED_ENDPOINT"
  | "DISCOURSE_RATE_LIMITED"
  | "DISCOURSE_BAD_RESPONSE"
  | "DISCOURSE_TOO_LARGE"
  | "DISCOURSE_SELECTION_REQUIRED"
  | "DISCOURSE_CONFIG_INVALID";

const FAILURES: Record<
  DiscourseErrorCode,
  { statusCode: number; message: string }
> = {
  DISCOURSE_FORUM_URL_INVALID: {
    statusCode: 400,
    message: "The forum address is not a valid public Discourse forum address.",
  },
  DISCOURSE_FORUM_UNREACHABLE: {
    statusCode: 502,
    message: "The Discourse forum could not be reached.",
  },
  DISCOURSE_NOT_A_DISCOURSE_SITE: {
    statusCode: 422,
    message: "The address does not belong to a Discourse forum.",
  },
  DISCOURSE_LOGIN_REQUIRED: {
    statusCode: 422,
    message: "The Discourse forum requires signing in, which is not supported.",
  },
  DISCOURSE_BLOCKED_ENDPOINT: {
    statusCode: 422,
    message: "The Discourse forum address is not allowed.",
  },
  DISCOURSE_RATE_LIMITED: {
    statusCode: 429,
    message: "The Discourse forum is limiting requests. Try again later.",
  },
  DISCOURSE_BAD_RESPONSE: {
    statusCode: 502,
    message: "The Discourse forum returned an unexpected response.",
  },
  DISCOURSE_TOO_LARGE: {
    statusCode: 422,
    message: "The Discourse forum selection is too large to read.",
  },
  DISCOURSE_SELECTION_REQUIRED: {
    statusCode: 422,
    message: "Choose at least one category or topic to index.",
  },
  DISCOURSE_CONFIG_INVALID: {
    statusCode: 400,
    message: "The Discourse connector settings are not valid.",
  },
};

/**
 * Error thrown by this package's Discourse layer. `apps/backend` copies
 * `statusCode`, `code` and `message` onto a `ConnectorError`. The message is a
 * fixed English string per code: it never contains the forum address, a
 * response body or an underlying error's text, and no `cause` is ever set.
 */
export class DiscourseError extends Error {
  readonly statusCode: number;
  readonly code: DiscourseErrorCode;

  constructor(code: DiscourseErrorCode) {
    super(FAILURES[code].message);
    this.name = "DiscourseError";
    this.statusCode = FAILURES[code].statusCode;
    this.code = code;
  }
}
