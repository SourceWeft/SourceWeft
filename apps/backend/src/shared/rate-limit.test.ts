import assert from "node:assert/strict";
import { test } from "vitest";
import { createRateLimiter, type RateLimitRule } from "./rate-limit";

/** An in-memory stand-in for the two Redis commands the limiter uses. */
function fakeRedis() {
  const counts = new Map<string, number>();
  return {
    counts,
    redis: {
      async mget(...keys: string[]) {
        return keys.map((key) =>
          counts.has(key) ? String(counts.get(key)) : null,
        );
      },
      multi() {
        const ops: Array<() => void> = [];
        const pipeline = {
          incr(key: string) {
            ops.push(() => counts.set(key, (counts.get(key) ?? 0) + 1));
            return pipeline;
          },
          expire() {
            return pipeline;
          },
          async exec() {
            ops.forEach((op) => op());
            return ops.map(() => [null, 1] as [null, number]);
          },
        };
        return pipeline;
      },
    },
  };
}

const user = (limit: number, windowSeconds = 60): RateLimitRule => ({
  key: "u:1",
  limit,
  windowSeconds,
  scope: "minute",
});

test("requests under the limit are allowed and counted", async () => {
  const { redis } = fakeRedis();
  const limiter = createRateLimiter(
    async () => redis,
    () => 1_000_000,
  );

  assert.deepEqual(await limiter.consume([user(2)]), { allowed: true });
  assert.deepEqual(await limiter.consume([user(2)]), { allowed: true });
});

test("the request over the limit is refused with the exact wait", async () => {
  const { redis } = fakeRedis();
  // 1_000_000 s is 40 s into a 60 s window, so 20 s remain.
  const limiter = createRateLimiter(
    async () => redis,
    () => 1_000_000 * 1000,
  );
  await limiter.consume([user(1)]);

  const verdict = await limiter.consume([user(1)]);

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.allowed === false && verdict.scope, "minute");
  assert.equal(verdict.allowed === false && verdict.retryAfterSeconds, 20);
  assert.equal(verdict.allowed === false && verdict.limit, 1);
});

test("the allowance comes back in the next window", async () => {
  const { redis } = fakeRedis();
  let nowMs = 1_000_000 * 1000;
  const limiter = createRateLimiter(
    async () => redis,
    () => nowMs,
  );
  await limiter.consume([user(1)]);
  assert.equal((await limiter.consume([user(1)])).allowed, false);

  nowMs += 21_000;

  assert.equal((await limiter.consume([user(1)])).allowed, true);
});

test("a refused request uses up none of its rules' allowance", async () => {
  const { redis, counts } = fakeRedis();
  const limiter = createRateLimiter(
    async () => redis,
    () => 1_000_000 * 1000,
  );
  const team: RateLimitRule = {
    key: "t:1",
    limit: 1,
    windowSeconds: 3600,
    scope: "team",
  };
  await limiter.consume([team]);

  const verdict = await limiter.consume([user(5), team]);

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.allowed === false && verdict.scope, "team");
  const userKeys = [...counts.keys()].filter((key) => key.includes("u:1"));
  assert.equal(userKeys.length, 0);
});

test("when several rules refuse, the longest wait is reported", async () => {
  const { redis } = fakeRedis();
  const limiter = createRateLimiter(
    async () => redis,
    () => 1_000_000 * 1000,
  );
  const hour: RateLimitRule = {
    key: "u:1",
    limit: 1,
    windowSeconds: 3600,
    scope: "hour",
  };
  await limiter.consume([user(1), hour]);

  const verdict = await limiter.consume([user(1), hour]);

  assert.equal(verdict.allowed === false && verdict.scope, "hour");
  assert.ok(verdict.allowed === false && verdict.retryAfterSeconds > 20);
});

test("different keys do not share a count", async () => {
  const { redis } = fakeRedis();
  const limiter = createRateLimiter(
    async () => redis,
    () => 1_000_000 * 1000,
  );
  await limiter.consume([user(1)]);

  const other = await limiter.consume([{ ...user(1), key: "u:2" }]);

  assert.equal(other.allowed, true);
});

test("a Redis failure is raised so the caller can refuse to spend", async () => {
  const limiter = createRateLimiter(async () => {
    throw new Error("redis down");
  });

  await assert.rejects(limiter.consume([user(1)]), /redis down/);
});

test("no rules means nothing to limit", async () => {
  const limiter = createRateLimiter(async () => {
    throw new Error("should not be called");
  });

  assert.deepEqual(await limiter.consume([]), { allowed: true });
});
