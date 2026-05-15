import type { Context } from "hono";
import { ZodError } from "zod";
import { isBillingError } from "../../modules/billing/errors";
import { isConnectorError } from "../../modules/connectors/errors";
import { isContentError } from "../../modules/content/errors";

export type ApiErrorBody = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static unauthorized(message = "Unauthorized") {
    return new ApiError(401, "UNAUTHORIZED", message);
  }

  static forbidden(message = "Forbidden") {
    return new ApiError(403, "FORBIDDEN", message);
  }

  static notFound(message = "Not found") {
    return new ApiError(404, "NOT_FOUND", message);
  }

  static invalidJson(message = "Invalid JSON body") {
    return new ApiError(400, "INVALID_JSON", message);
  }

  static validation(details?: Record<string, unknown>) {
    return new ApiError(
      400,
      "VALIDATION_ERROR",
      "Invalid request body",
      details,
    );
  }
}

export class ApiResponse {
  static success<T>(c: Context, data: T, statusCode = 200) {
    return c.json(data, statusCode as never);
  }

  static error(c: Context, error: ApiError) {
    const body: ApiErrorBody = {
      code: error.code,
      message: error.message,
    };

    if (error.details && Object.keys(error.details).length > 0) {
      body.details = error.details;
    }

    return c.json(body, error.statusCode as never);
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  if (isContentError(error)) {
    return new ApiError(error.statusCode, error.code, error.message);
  }

  if (isConnectorError(error)) {
    return new ApiError(
      error.statusCode,
      error.code,
      error.message,
      error.details,
    );
  }

  if (isBillingError(error)) {
    return new ApiError(
      error.statusCode,
      error.code,
      error.message,
      error.details,
    );
  }

  if (error instanceof ZodError) {
    return ApiError.validation(error.flatten() as Record<string, unknown>);
  }

  return new ApiError(500, "INTERNAL_SERVER_ERROR", "Internal server error");
}
