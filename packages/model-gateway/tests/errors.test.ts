import assert from "node:assert/strict";
import test from "node:test";
import {
  createHttpGatewayError,
  isRetryableError,
  ModelGatewayError,
  normalizeGatewayError,
} from "../src/index";
import { isFailoverableError } from "../src/errors";

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

test("normalizeGatewayError preserves a nested transport policy refusal", () => {
  const refusal = new ModelGatewayError({
    code: "POLICY",
    message: "Endpoint is not allowed",
    retryable: false,
  });
  const wrapped = new Error("SDK connection error", {
    cause: new Error("fetch failed", { cause: refusal }),
  });
  assert.equal(normalizeGatewayError(wrapped), refusal);
  assert.equal(isRetryableError(wrapped), false);
  assert.equal(isFailoverableError(wrapped), false);
});

test("normalizeGatewayError terminates when an SDK error cause is cyclic", () => {
  const error = new Error("cyclic SDK connection error");
  const nested = new Error("nested error", { cause: error });
  Object.assign(error, { cause: nested });
  const normalized = normalizeGatewayError(error);
  assert.equal(normalized.code, "UPSTREAM");
  assert.equal(normalized.message, error.message);
});

test("normalizeGatewayError does not promote arbitrary nested errors over the outer HTTP status", () => {
  const wrapped = Object.assign(new Error("Upstream unavailable"), {
    status: 503,
    cause: new ModelGatewayError({ code: "AUTH", message: "Inner auth error" }),
  });
  assert.equal(normalizeGatewayError(wrapped).code, "UPSTREAM");
});

test("configuration errors are non-retryable and cannot fail over", () => {
  const error = new ModelGatewayError({
    code: "CONFIGURATION",
    message: "No usable configured target",
  });
  assert.equal(normalizeGatewayError(error), error);
  assert.equal(error.retryable, false);
  assert.equal(isRetryableError(error), false);
  assert.equal(isFailoverableError(error), false);
});

for (const statusCode of [401, 403]) {
  test(`real provider HTTP ${statusCode} remains an authentication error`, () => {
    const httpError = createHttpGatewayError({
      statusCode,
      body: { error: { message: "Upstream rejected the supplied credential" } },
    });
    const sdkError = normalizeGatewayError(
      Object.assign(new Error("Upstream rejected the supplied credential"), {
        status: statusCode,
      }),
    );
    for (const error of [httpError, sdkError]) {
      assert.equal(error.code, "AUTH");
      assert.equal(error.statusCode, statusCode);
      assert.equal(error.retryable, false);
    }
  });
}
