import assert from "node:assert/strict";
import { test } from "vitest";
import { isRetryableOAuthRefreshError } from "./oauth-refresh-error";

test("temporary OAuth failures do not require a new consent grant", () => {
  assert.equal(isRetryableOAuthRefreshError({ statusCode: 503 }), true);
  assert.equal(isRetryableOAuthRefreshError({ statusCode: 429 }), true);
  assert.equal(isRetryableOAuthRefreshError({ statusCode: 401 }), false);
  assert.equal(isRetryableOAuthRefreshError(new Error("invalid_grant")), false);
});

test("transport failures do not require a new consent grant", () => {
  const fetchFailed = new TypeError("fetch failed");
  const reset = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  const undici = Object.assign(new Error("connect timeout"), {
    code: "UND_ERR_CONNECT_TIMEOUT",
  });
  for (const error of [fetchFailed, reset, timeout, aborted, undici]) {
    assert.equal(isRetryableOAuthRefreshError(error), true);
  }
});

test("a refusal without a status still requires a new consent grant", () => {
  assert.equal(isRetryableOAuthRefreshError(new Error("invalid_grant")), false);
  assert.equal(isRetryableOAuthRefreshError(new TypeError("bad input")), false);
  assert.equal(isRetryableOAuthRefreshError({ statusCode: 400 }), false);
  assert.equal(isRetryableOAuthRefreshError(null), false);
});
