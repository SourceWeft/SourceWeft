import assert from "node:assert/strict";
import test from "node:test";
import {
  createHttpGatewayError,
  isRetryableError,
  normalizeGatewayError,
} from "../src/index";

test("createHttpGatewayError maps HTTP responses into gateway errors", () => {
  const error = createHttpGatewayError({
    statusCode: 429,
    requestId: "req_123",
    body: {
      error: {
        message: "Rate limit exceeded",
        type: "openai",
      },
    },
  });

  assert.equal(error.code, "RATE_LIMIT");
  assert.equal(error.message, "Rate limit exceeded");
  assert.equal(error.provider, "openai");
  assert.equal(error.requestId, "req_123");
  assert.equal(error.retryable, true);
  assert.equal(isRetryableError(error), true);
});

test("normalizeGatewayError maps AbortError to TIMEOUT", () => {
  const abortError = Object.assign(new Error("Timed out"), {
    name: "AbortError",
  });

  const normalized = normalizeGatewayError(abortError);

  assert.equal(normalized.code, "TIMEOUT");
  assert.equal(normalized.message, "Timed out");
  assert.equal(normalized.retryable, true);
});
