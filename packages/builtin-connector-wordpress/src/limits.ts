/** Items requested per WordPress REST list page (the REST maximum). */
export const PER_PAGE = 100;

/** At most this many posts and pages are indexed per scan, across all selections. */
export const MAX_ITEMS = 5_000;

/** Upper bound on HTTP requests one scan may issue. */
export const MAX_REQUESTS = 2_000;

/** Wall-clock ceiling for one scan. */
export const SCAN_TIMEOUT_MS = 900_000;

/** Per-request timeout. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Response body ceiling, measured after decompression. */
export const MAX_RESPONSE_BYTES = 10_485_760;

/** Retries for a transient failure of one request. */
export const MAX_RETRIES = 2;

/** Longest wait honoured for a retry or a `Retry-After` header. */
export const MAX_RETRY_DELAY_MS = 30_000;

/** Minimum gap between two requests to the same site. */
export const MIN_REQUEST_GAP_MS = 150;

/** Maximum selections (types, categories, posts and pages) a connector may hold. */
export const MAX_SELECTED_ITEMS = 500;

/** Rendered text ceiling per indexed post or page. */
export const MAX_TEXT_CHARS = 500_000;

/** Pages of one category listing a browse or scan reads. */
export const MAX_CATEGORY_PAGES = 20;

/** Tag ids resolved to names for one scan. */
export const MAX_TAG_IDS = 2_000;

/** Category and tag names recorded in an item's metadata. */
export const MAX_METADATA_TERMS = 50;

/**
 * Wall-clock ceiling for one selection action or readiness check (a scan has
 * its own, {@link SCAN_TIMEOUT_MS}).
 */
export const ACTION_DEADLINE_MS = 60_000;

/** Bytes of the site home page read when discovering the REST root. */
export const HOME_HTML_BYTES = 262_144;

/** Times a scan restarts after the site changes under it. */
export const MAX_SCAN_RESTARTS = 2;

/** Sent on every WordPress request. */
export const WORDPRESS_USER_AGENT =
  "SourceWeft-WordPressConnector/1.0 (+https://sourceweft.com)";
