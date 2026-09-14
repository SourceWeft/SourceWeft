import "server-only";
export function internalApiBaseUrl() {
  const value = process.env.INTERNAL_API_BASE_URL?.trim();
  if (value) return value.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production")
    throw new Error(
      "INTERNAL_API_BASE_URL is required for server-side API requests.",
    );
  const legacyName = "NEXT_PUBLIC_API_BASE_URL";
  return (process.env[legacyName]?.trim() || "http://localhost:3001").replace(
    /\/$/,
    "",
  );
}
