/**
 * Fixed-window counters in the shared Redis, so a limit holds across api
 * replicas. Several rules (a user's, their team's) are checked together and a
 * request is counted against all of them or none, so a refused request never
 * uses up allowance it did not spend.
 *
 * Windows are aligned to the clock, which keeps the keys cheap and the
 * "try again in N seconds" answer exact. The counts are best effort under a
 * burst of simultaneous requests (a couple may slip past a limit); the limits
 * bound cost, they are not a security boundary.
 */
export type RateLimitRule = {
  /** What is counted, e.g. `source-discovery:user:<id>`. */
  key: string;
  limit: number;
  windowSeconds: number;
  /** Named in the verdict when this rule is the one that refuses. */
  scope: string;
};

export type RateLimitVerdict =
  | { allowed: true }
  | {
      allowed: false;
      scope: string;
      limit: number;
      windowSeconds: number;
      /** When the refusing window clears; the longest wait if several refuse. */
      retryAfterSeconds: number;
    };

/**
 * The shared Redis, loaded on first use so that importing this module (in a
 * unit test, say) does not open a connection.
 */
async function sharedRedis(): Promise<RedisPort> {
  const { jobsRedisClient } = await import("./queue");
  return (await jobsRedisClient()) as unknown as RedisPort;
}

type RedisPort = {
  mget(...keys: string[]): Promise<Array<string | null>>;
  multi(): {
    incr(key: string): unknown;
    expire(key: string, seconds: number): unknown;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
  };
};

export type RateLimiter = {
  consume(rules: readonly RateLimitRule[]): Promise<RateLimitVerdict>;
};

export function createRateLimiter(
  getRedis: () => Promise<RedisPort> = sharedRedis,
  now: () => number = Date.now,
): RateLimiter {
  return {
    async consume(rules) {
      if (rules.length === 0) return { allowed: true };
      const seconds = Math.floor(now() / 1000);
      const slots = rules.map((rule) => ({
        rule,
        redisKey: `rate:${rule.key}:${rule.windowSeconds}:${Math.floor(seconds / rule.windowSeconds)}`,
        retryAfterSeconds:
          rule.windowSeconds - (seconds % rule.windowSeconds) ||
          rule.windowSeconds,
      }));

      const redis = await getRedis();
      const counts = await redis.mget(...slots.map((slot) => slot.redisKey));
      const refused = slots
        .filter((slot, index) => Number(counts[index] ?? 0) >= slot.rule.limit)
        .sort((a, b) => b.retryAfterSeconds - a.retryAfterSeconds);
      if (refused.length > 0) {
        const worst = refused[0]!;
        return {
          allowed: false,
          scope: worst.rule.scope,
          limit: worst.rule.limit,
          windowSeconds: worst.rule.windowSeconds,
          retryAfterSeconds: worst.retryAfterSeconds,
        };
      }

      const pipeline = redis.multi();
      for (const slot of slots) {
        pipeline.incr(slot.redisKey);
        pipeline.expire(slot.redisKey, slot.rule.windowSeconds + 1);
      }
      const results = await pipeline.exec();
      for (const [error] of results ?? []) {
        if (error) throw error;
      }
      return { allowed: true };
    },
  };
}

export const rateLimiter = createRateLimiter();
