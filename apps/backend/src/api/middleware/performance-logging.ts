import type { Context, Next } from "hono";
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";
import { metrics } from "../../shared/metrics";

function parseContentLength(value: string | null) {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function requestParam(c: Context, key: string) {
  const value = c.req.param(key);
  return value && value.length > 0 ? value : null;
}

export async function performanceLoggingMiddleware(c: Context, next: Next) {
  const startedAt = performance.now();

  await next();

  // Once the handler has run, `routePath` is the matched handler's template
  // (`/v1/workspaces/:workspaceId/threads`), or this middleware's own pattern
  // when nothing matched. Never the raw path, so ids stay out of metric keys.
  metrics.inc("http.requests", {
    method: c.req.method,
    route: c.req.routePath,
    status: c.res.status,
  });

  const durationMs = Math.round(performance.now() - startedAt);
  const responseSizeBytes = parseContentLength(
    c.res.headers.get("content-length"),
  );
  const isSlow =
    durationMs >= config.apiPerformance.slowRequestThresholdMs;
  const isLargeResponse =
    responseSizeBytes !== null &&
    responseSizeBytes >= config.apiPerformance.largeResponseThresholdBytes;

  if (!isSlow && !isLargeResponse) {
    return;
  }

  const pathname = new URL(c.req.url).pathname;
  const thresholdsExceeded = [
    ...(isSlow ? (["slow_request"] as const) : []),
    ...(isLargeResponse ? (["large_response"] as const) : []),
  ];
  const meta = {
    durationMs,
    largeResponseThresholdBytes:
      config.apiPerformance.largeResponseThresholdBytes,
    method: c.req.method,
    pathname,
    responseSizeBytes,
    slowRequestThresholdMs: config.apiPerformance.slowRequestThresholdMs,
    status: c.res.status,
    teamId: requestParam(c, "teamId"),
    thresholdsExceeded,
    workspaceId: requestParam(c, "workspaceId"),
  };

  if (c.res.status >= 500) {
    logger.warn("API request performance threshold exceeded", meta);
    return;
  }

  logger.info("API request performance threshold exceeded", meta);
}
