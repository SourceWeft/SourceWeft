// Shared error type and status mapping for every Atlassian client call. Jira and
// Confluence each pass their own `errorPrefix` so the same mapping logic produces
// `JIRA_*` or `CONFLUENCE_*` codes (see Global Constraints: error codes are
// prefixed per product and end with the spec A4 suffixes).

export type AtlassianErrorPrefix = "JIRA" | "CONFLUENCE";

export class AtlassianApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: { retryAfterSeconds: number };

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: { retryAfterSeconds: number },
  ) {
    super(message);
    this.name = "AtlassianApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function requestFailed(
  prefix: AtlassianErrorPrefix,
  statusCode: number,
  suffix: string,
  message: string,
  details?: { retryAfterSeconds: number },
): AtlassianApiError {
  return new AtlassianApiError(statusCode, `${prefix}_${suffix}`, message, details);
}

/** Clamped integer `Retry-After`: default 60 when the header is absent or not a
 * positive number, otherwise clamped to 1-3600 seconds. */
function parseRetryAfterSeconds(response: Response): number {
  const header = response.headers.get("retry-after");
  const value = header === null ? NaN : Number(header);
  if (!Number.isFinite(value) || value <= 0) return 60;
  return Math.min(3600, Math.max(1, Math.trunc(value)));
}

/** Maps a non-2xx status from a product/identity API call (never the token
 * endpoint, which has its own, stricter mapping below). */
export function mapApiError(response: Response, prefix: AtlassianErrorPrefix): AtlassianApiError {
  const status = response.status;
  if (status === 401) {
    return requestFailed(prefix, 401, "REAUTH_REQUIRED", `Atlassian request failed (${status})`);
  }
  if (status === 403 || status === 404) {
    return requestFailed(prefix, 404, "NOT_FOUND", `Atlassian request failed (${status})`);
  }
  if (status === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(response);
    return requestFailed(
      prefix,
      429,
      "RATE_LIMITED",
      `Atlassian rate limit reached; retry after ${retryAfterSeconds} seconds`,
      { retryAfterSeconds },
    );
  }
  if (status === 400) {
    return requestFailed(prefix, 400, "INVALID_REQUEST", `Atlassian request failed (${status})`);
  }
  if (status >= 500) {
    return requestFailed(prefix, 503, "UNAVAILABLE", `Atlassian request failed (${status})`);
  }
  return requestFailed(prefix, status, "REQUEST_FAILED", `Atlassian request failed (${status})`);
}

/** Maps a non-2xx status from the token endpoint. Every failure other than a
 * rate limit or an outage collapses to `_REAUTH_REQUIRED` with status 400 so the
 * platform's refresh path treats it as non-retryable. */
export function mapTokenError(response: Response, prefix: AtlassianErrorPrefix): AtlassianApiError {
  const status = response.status;
  if (status === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(response);
    return requestFailed(
      prefix,
      429,
      "RATE_LIMITED",
      `Atlassian rate limit reached; retry after ${retryAfterSeconds} seconds`,
      { retryAfterSeconds },
    );
  }
  if (status >= 500) {
    return requestFailed(prefix, 503, "UNAVAILABLE", `Atlassian request failed (${status})`);
  }
  return requestFailed(prefix, 400, "REAUTH_REQUIRED", `Atlassian request failed (${status})`);
}

/** Network error / timeout, normalized the same way for every endpoint. */
export function unavailableError(prefix: AtlassianErrorPrefix): AtlassianApiError {
  return requestFailed(prefix, 503, "UNAVAILABLE", "Atlassian is unavailable");
}
