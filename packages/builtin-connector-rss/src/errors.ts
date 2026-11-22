import type { FeedUrlRejection } from "./feed-url";

export type FeedFetchFailure =
  | "feed_blocked_address"
  | "feed_timeout"
  | "feed_too_large"
  | "feed_not_a_feed"
  | "feed_http_error"
  | "feed_unreachable";

export type RssAdapterReason = FeedFetchFailure | FeedUrlRejection;

const FAILURES: Record<
  RssAdapterReason,
  { statusCode: number; message: string }
> = {
  feed_url_invalid: { statusCode: 400, message: "The feed URL is not valid." },
  feed_https_required: {
    statusCode: 400,
    message: "The feed URL must use https.",
  },
  feed_credentials_not_allowed: {
    statusCode: 400,
    message: "The feed URL must not contain a username or password.",
  },
  feed_blocked_address: {
    statusCode: 422,
    message: "The feed address is not a public internet address.",
  },
  feed_timeout: { statusCode: 504, message: "The feed request timed out." },
  feed_too_large: { statusCode: 422, message: "The feed is too large." },
  feed_not_a_feed: {
    statusCode: 422,
    message: "The response is not an RSS 2.0 or Atom 1.0 feed.",
  },
  feed_http_error: {
    statusCode: 502,
    message: "The feed server returned an error.",
  },
  feed_unreachable: {
    statusCode: 502,
    message: "The feed server could not be reached.",
  },
};

/**
 * Error thrown by this package's feed layer. `apps/backend` copies `statusCode`,
 * `code` and `message` onto a `ConnectorError`. The message is a fixed English
 * string per reason: it never contains the feed URL (which may carry a token in
 * its query), never repeats an underlying fetch or policy error message, and no
 * `cause` is ever set.
 */
export class RssAdapterError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly reason: RssAdapterReason;

  constructor(reason: RssAdapterReason) {
    const failure = FAILURES[reason];
    super(failure.message);
    this.name = "RssAdapterError";
    this.statusCode = failure.statusCode;
    this.code = reason;
    this.reason = reason;
  }
}
