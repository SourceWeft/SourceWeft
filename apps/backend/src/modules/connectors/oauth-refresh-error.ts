export function isRetryableOAuthRefreshError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return (
    typeof statusCode === "number" &&
    (statusCode === 429 || statusCode >= 500)
  );
}
