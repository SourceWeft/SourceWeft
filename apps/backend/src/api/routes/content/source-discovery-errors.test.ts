import assert from "node:assert/strict";
import { test } from "vitest";
import { discoveryRateLimitedError } from "./source-discovery-errors";

test("the 429 carries which limit was hit and when it clears", () => {
  const error = discoveryRateLimitedError({
    scope: "hour",
    retryAfterSeconds: 1380,
    limit: 150,
    windowSeconds: 3600,
  });

  assert.equal(error.statusCode, 429);
  assert.equal(error.code, "SOURCE_DISCOVERY_RATE_LIMITED");
  assert.deepEqual(error.details, {
    scope: "hour",
    retryAfterSeconds: 1380,
    limit: 150,
    windowSeconds: 3600,
  });
});

test("each limit has its own plain message", () => {
  const messages = (["minute", "hour", "day", "team"] as const).map(
    (scope) =>
      discoveryRateLimitedError({
        scope,
        retryAfterSeconds: 5,
        limit: 1,
        windowSeconds: 60,
      }).message,
  );
  assert.equal(new Set(messages).size, 4);
});
