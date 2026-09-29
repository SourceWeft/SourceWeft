import { logger } from "../../shared/logger";
import type { ApiError } from "./api-response";
import { describeError } from "./error-detail";

/**
 * Logs one failed API request. A client error (4xx) is the API answering as
 * designed — a missing manifest, an invalid body — so it is recorded at info
 * without a stack; only a server fault (5xx) is an error. Both name the
 * requester's user agent, so a sweep of one endpoint shows who sent it.
 */
export function logApiError(input: {
  method: string;
  pathname: string;
  userAgent?: string | null;
  apiError: ApiError;
  error: unknown;
}) {
  const detail = describeError(input.error);
  const request = {
    method: input.method,
    pathname: input.pathname,
    code: input.apiError.code,
    status: input.apiError.statusCode,
    userAgent: input.userAgent ?? null,
  };
  if (input.apiError.statusCode < 500) {
    logger.info("API request rejected", {
      ...request,
      error: detail.message,
    });
    return;
  }
  logger.error("API request failed", {
    ...request,
    errorName: detail.name,
    error: detail.message,
    errorStack: detail.stack,
    errorResponseStatus: detail.status,
    errorBodyCode: detail.bodyCode,
    errorBodyMessage: detail.bodyMessage,
    errorResponseStatusText: detail.statusText,
    errorResponseUrl: detail.url,
  });
}
