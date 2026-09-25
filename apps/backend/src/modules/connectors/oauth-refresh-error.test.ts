import assert from "node:assert/strict";
import { test } from "vitest";
import { isRetryableOAuthRefreshError } from "./oauth-refresh-error";

test("temporary OAuth failures do not require a new consent grant", () => {
  assert.equal(isRetryableOAuthRefreshError({ statusCode: 503 }), true);
  assert.equal(isRetryableOAuthRefreshError({ statusCode: 429 }), true);
  assert.equal(isRetryableOAuthRefreshError({ statusCode: 401 }), false);
  assert.equal(isRetryableOAuthRefreshError(new Error("invalid_grant")), false);
});
