/** Deepest collection level a scan descends below a selected root. */
export const MAX_DEPTH = 8;

/** Entries (files and collections) one scan may visit before it stops and
 * reports itself incomplete, so nothing is archived on a partial walk. */
export const MAX_ENTRIES = 20_000;

/** Folders one connector may select. Also the selection's `maxItems`. */
export const MAX_ROOTS = 20;

/** A PROPFIND response ceiling, measured on the bytes read from the wire. */
export const MAX_MULTISTATUS_BYTES = 5 * 1024 * 1024;

/** Per-request timeout, covering the headers and the body read. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Wall-clock budget for one whole scan. */
export const SCAN_TIMEOUT_MS = 10 * 60_000;

/** Largest file a download may return: the same ceiling the connector
 * pipeline applies to every provider download (Dropbox included). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Retries after the first attempt, for network errors and 429/502/503/504. */
export const MAX_RETRIES = 2;

/** Longest a `Retry-After` header may delay a retry. */
export const MAX_RETRY_DELAY_MS = 10_000;

/** Longest accepted endpoint URL. */
export const ENDPOINT_MAX_LENGTH = 2048;

/** Longest accepted decoded path (selection ids are further capped by
 * {@link MAX_ROOT_LENGTH}). */
export const MAX_PATH_LENGTH = 1024;

/** Longest accepted selected root, matching the selection id limit. */
export const MAX_ROOT_LENGTH = 512;

/** Identifies the fetcher without personal contact details. */
export const WEBDAV_USER_AGENT =
  "SourceWeft-WebDavConnector/1.0 (+https://sourceweft.com)";
