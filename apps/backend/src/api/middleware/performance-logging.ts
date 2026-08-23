import type { Context, Next } from "hono";
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";

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
