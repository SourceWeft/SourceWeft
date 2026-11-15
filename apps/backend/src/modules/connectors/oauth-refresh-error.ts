const TRANSPORT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

function hasTransportErrorCode(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const code = (value as { code?: unknown }).code;
  return (
    typeof code === "string" &&
    (TRANSPORT_ERROR_CODES.has(code) || code.startsWith("UND_ERR_"))
  );
}

function isTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  if (error instanceof TypeError && error.message === "fetch failed") {
    return true;
  }
  if (hasTransportErrorCode(error)) return true;
  const cause = (error as { cause?: unknown }).cause;
  return hasTransportErrorCode(cause);
}

export function isRetryableOAuthRefreshError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === "number") {
    return statusCode === 429 || statusCode >= 500;
  }
  return isTransportFailure(error);
}
