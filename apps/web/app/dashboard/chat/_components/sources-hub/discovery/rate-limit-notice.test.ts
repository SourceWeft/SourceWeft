import assert from "node:assert/strict";
import { test } from "vitest";
import { HttpClientError } from "@sourceweft/sdk";
import {
  formatAgo,
  formatClock,
  formatWait,
  parseRateLimit,
} from "./rate-limit-notice";

const limited = (
  details: Record<string, unknown>,
  code = "SOURCE_DISCOVERY_RATE_LIMITED",
) =>
  new HttpClientError({
    message: "slow down",
    status: 429,
    statusText: "Too Many Requests",
    code,
    details,
  });

test("a discovery limit error becomes a notice with the moment it clears", () => {
  const notice = parseRateLimit(
    limited({ scope: "hour", retryAfterSeconds: 1380 }),
    1_000_000,
  );

  assert.deepEqual(notice, { scope: "hour", until: 1_000_000 + 1_380_000 });
});

test("other errors are not a limit notice", () => {
  assert.equal(parseRateLimit(new Error("x"), 0), null);
  assert.equal(
    parseRateLimit(
      new HttpClientError({
        message: "x",
        status: 402,
        statusText: "",
        code: "INSUFFICIENT_CREDITS",
      }),
      0,
    ),
    null,
  );
  assert.equal(
    parseRateLimit(
      limited({ scope: "minute", retryAfterSeconds: 5 }, "OTHER"),
      0,
    ),
    null,
  );
});

test("missing or odd details fall back to a one-minute wait", () => {
  assert.deepEqual(parseRateLimit(limited({}), 0), {
    scope: "minute",
    until: 60_000,
  });
  assert.deepEqual(
    parseRateLimit(limited({ scope: "nonsense", retryAfterSeconds: -4 }), 0),
    { scope: "minute", until: 60_000 },
  );
});

test("waits are shown in the reader's language and units", () => {
  assert.equal(formatWait(42, "en"), "42s");
  assert.equal(formatWait(0.2, "en"), "1s");
  assert.equal(formatWait(300, "en"), "5m");
  assert.equal(formatWait(3900, "en"), "1h 5m");
  assert.equal(formatWait(3600, "en"), "1h");
  assert.match(formatWait(300, "zh-CN"), /5/);
});

test("the clock time and the age use the locale", () => {
  assert.match(formatClock(Date.UTC(2026, 10, 15, 15, 42), "en"), /\d/);
  assert.equal(formatAgo(new Date(0).toISOString(), 30_000, "en"), "now");
  assert.equal(
    formatAgo(new Date(0).toISOString(), 12 * 60_000, "en"),
    "12 minutes ago",
  );
  assert.equal(
    formatAgo(new Date(0).toISOString(), 3 * 3600_000, "en"),
    "3 hours ago",
  );
});
