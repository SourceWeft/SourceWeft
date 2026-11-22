/** Response body ceiling, measured after decompression. */
export const FEED_MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Per-request timeout for a feed fetch. */
export const FEED_TIMEOUT_MS = 15_000;

/** At most this many items are indexed per feed per sync. */
export const FEED_MAX_ITEMS = 500;

/** Identifies the fetcher without personal contact details. */
export const FEED_USER_AGENT =
  "SourceWeft-FeedFetcher/1.0 (+https://sourceweft.com)";
