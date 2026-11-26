/** Topics a Discourse list endpoint returns per page, unless the site differs. */
export const PAGE_SIZE_ASSUMED = 30;

/** At most this many topics are listed from one category per scan. */
export const MAX_TOPICS_PER_CATEGORY = 2_000;

/** At most this many topics are indexed per scan, across all selections. */
export const MAX_TOPICS = 5_000;

/** Upper bound on HTTP requests one scan may issue. */
export const MAX_REQUESTS = 2_000;

/** Wall-clock ceiling for one scan. */
export const SCAN_TIMEOUT_MS = 900_000;

/** Posts read from a single topic; later posts are dropped. */
export const MAX_POSTS_PER_TOPIC = 500;

/** Post ids requested per `posts.json` batch. */
export const POST_BATCH = 20;

/** Per-request timeout. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Response body ceiling, measured after decompression. */
export const MAX_RESPONSE_BYTES = 10_485_760;

/** Retries for a transient failure of one request. */
export const MAX_RETRIES = 2;

/** Longest wait honoured for a retry or a `Retry-After` header. */
export const MAX_RETRY_DELAY_MS = 30_000;

/** Minimum gap between two requests to the same forum. */
export const MIN_REQUEST_GAP_MS = 150;

/** Maximum categories and topics a connector may select. */
export const MAX_SELECTED_ITEMS = 500;

/** Rendered text ceiling per indexed topic. */
export const MAX_TEXT_CHARS = 500_000;

/** Post ids recorded in an item's metadata. */
export const MAX_METADATA_POST_IDS = 500;

/** Distinct author names recorded in an item's metadata. */
export const MAX_METADATA_AUTHORS = 100;
