import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { logger } from "../../shared/logger";
import { ApiError } from "./api-response";
import { logApiError } from "./log-api-error";

const request = {
  method: "GET",
  pathname: "/v1/mcp/so.rails%2Fpoker/manifest",
  userAgent: "ExampleCrawler/1.0",
};

afterEach(() => {
  vi.restoreAllMocks();
});

test("a 404 is logged at info without a stack, naming the requester", () => {
  const info = vi.spyOn(logger, "info");
  const error = vi.spyOn(logger, "error");
  logApiError({
    ...request,
    apiError: ApiError.notFound("MCP manifest not found"),
    error: ApiError.notFound("MCP manifest not found"),
  });
  assert.equal(error.mock.calls.length, 0);
  assert.equal(info.mock.calls.length, 1);
  const [message, fields] = info.mock.calls[0]! as [string, Record<string, unknown>];
  assert.equal(message, "API request rejected");
  assert.equal(fields.status, 404);
  assert.equal(fields.code, "NOT_FOUND");
  assert.equal(fields.error, "MCP manifest not found");
  assert.equal(fields.pathname, request.pathname);
  assert.equal(fields.userAgent, "ExampleCrawler/1.0");
  assert.equal("errorStack" in fields, false);
});

test("a 400 is a client error too", () => {
  const info = vi.spyOn(logger, "info");
  const error = vi.spyOn(logger, "error");
  logApiError({
    ...request,
    apiError: ApiError.validation({ field: "name" }),
    error: ApiError.validation({ field: "name" }),
  });
  assert.equal(error.mock.calls.length, 0);
  assert.equal((info.mock.calls[0]![1] as { status: number }).status, 400);
});

test("a server fault stays at error with its stack and the requester", () => {
  const info = vi.spyOn(logger, "info");
  const error = vi.spyOn(logger, "error");
  const cause = new Error("database unavailable");
  logApiError({
    ...request,
    apiError: new ApiError(500, "INTERNAL_ERROR", "Internal server error"),
    error: cause,
  });
  assert.equal(info.mock.calls.length, 0);
  assert.equal(error.mock.calls.length, 1);
  const [message, fields] = error.mock.calls[0]! as [string, Record<string, unknown>];
  assert.equal(message, "API request failed");
  assert.equal(fields.status, 500);
  assert.equal(fields.error, "database unavailable");
  assert.match(String(fields.errorStack), /database unavailable/);
  assert.equal(fields.userAgent, "ExampleCrawler/1.0");
});
