import { createHash } from "node:crypto";
import type { Context } from "hono";

/**
 * JSON response with a content-hash ETag + Cache-Control that honors
 * If-None-Match (304). Catalog reads are safe to revalidate cheaply; a manifest
 * is immutable per identifier@version so it can be cached hard.
 *
 * Shared by the public, anonymous catalogs (MCP and skills): both are read far
 * more often than they change, by callers that hold no session to vary on.
 */
export function cachedJson(
  c: Context,
  body: unknown,
  options: { maxAge?: number; immutable?: boolean } = {},
) {
  const payload = JSON.stringify(body);
  const etag = `"${createHash("sha256").update(payload).digest("hex").slice(0, 32)}"`;
  const maxAge = options.maxAge ?? 60;
  c.header("etag", etag);
  c.header(
    "cache-control",
    options.immutable
      ? `public, max-age=${maxAge}, immutable`
      : `public, max-age=${maxAge}`,
  );
  if (c.req.header("if-none-match") === etag) {
    return c.body(null, 304);
  }
  c.header("content-type", "application/json; charset=UTF-8");
  return c.body(payload, 200);
}
