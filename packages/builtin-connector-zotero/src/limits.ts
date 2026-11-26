/** Items requested per Zotero API page (the API maximum). */
export const PAGE_SIZE = 100;
/** Ceiling on library objects (collections, items, attachments) one scan reads. */
export const MAX_OBJECTS = 100_000;
/** Ceiling on HTTP requests one scan makes. */
export const MAX_REQUESTS = 2_000;
/** How often a scan may restart after the library version changed mid-scan. */
export const MAX_RESTARTS = 2;
export const REQUEST_TIMEOUT_MS = 30_000;
export const SCAN_TIMEOUT_MS = 900_000;
/** Retries of a transient failure, per request. */
export const MAX_RETRIES = 2;
/** Longest single retry delay honoured from a `Retry-After` header. */
export const MAX_RETRY_DELAY_MS = 10_000;
/** Longest `Backoff` wait the scan accepts before giving up. */
export const MAX_BACKOFF_WAIT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 10_485_760;
/** Collections a member may select for one connector. */
export const MAX_SELECTED_COLLECTIONS = 50;
/** Longest age of a cached shortcut before it is re-resolved (24 hours). */
export const SHORTCUT_MAX_AGE_MS = 86_400_000;
/** Ceiling on extracted characters per indexed document. */
export const MAX_TEXT_CHARS = 500_000;
