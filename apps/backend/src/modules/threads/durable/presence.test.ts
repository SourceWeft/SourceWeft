import assert from "node:assert/strict";
import { test } from "vitest";
import { distinctViewerIds, userIdFromMember } from "./presence-store";
import { typingRateLimiter } from "./typing-rate-limit";

test("userIdFromMember splits on the last colon (userId : connId)", () => {
  assert.equal(userIdFromMember("user-1:conn-9"), "user-1");
  // Defensive: a member with no colon is treated as the whole userId.
  assert.equal(userIdFromMember("user-1"), "user-1");
});

test("distinctViewerIds dedupes a user's multiple connections to one viewer", () => {
  assert.deepEqual(
    distinctViewerIds(["u1:c1", "u1:c2", "u2:c3"]),
    ["u1", "u2"],
  );
});

test("distinctViewerIds of an empty roster is empty", () => {
  assert.deepEqual(distinctViewerIds([]), []);
});

test("typing rate limiter drops a second ping within the interval, per (user,thread)", () => {
  // Immediate calls are well within SERVER_MIN_INTERVAL_MS.
  assert.equal(typingRateLimiter.allow("user-A", "thread-1"), true);
  assert.equal(typingRateLimiter.allow("user-A", "thread-1"), false);
  // A different thread for the same user is independent.
  assert.equal(typingRateLimiter.allow("user-A", "thread-2"), true);
  // A different user on the same thread is independent.
  assert.equal(typingRateLimiter.allow("user-B", "thread-1"), true);
  assert.equal(typingRateLimiter.allow("user-B", "thread-1"), false);
});
