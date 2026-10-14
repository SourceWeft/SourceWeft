import type { MiddlewareHandler } from "hono";

/**
 * Baseline hardening for every API response. Only headers that are safe on an
 * API whose bytes are embedded cross-origin: no framing headers, because the
 * public share routes allow the web origin to frame them and say so in their
 * own `Content-Security-Policy` (`frame-ancestors`), which `X-Frame-Options`
 * cannot express. A route's own value for any of these wins; the middleware
 * only fills in what the route left unset.
 */
const SECURITY_HEADERS: ReadonlyArray<readonly [name: string, value: string]> =
  [
    // Browsers ignore HSTS over plain http, so a self-host without TLS is
    // unaffected.
    ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
    ["X-Content-Type-Options", "nosniff"],
    // API responses are not pages; nothing they lead to needs the caller's
    // URL, and some of those URLs carry tokens.
    ["Referrer-Policy", "no-referrer"],
  ];

export const securityHeadersMiddleware: MiddlewareHandler = async (
  c,
  next,
) => {
  await next();
  for (const [name, value] of SECURITY_HEADERS) {
    if (!c.res.headers.has(name)) {
      c.header(name, value);
    }
  }
};
