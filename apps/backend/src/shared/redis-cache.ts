import { logger } from "./logger";

/**
 * A small JSON cache in the shared Redis for results that are worth keeping
 * but never worth failing over. A Redis error is a miss on read and a no-op on
 * write, and is logged: callers get the slower, uncached answer instead of an
 * error. Only cache what is the same for everyone and safe to share.
 */
export type CacheEntry<T> = { value: T; storedAt: number };

/**
 * The shared Redis, loaded on first use so that importing this module (in a
 * unit test, say) does not open a connection.
 */
async function sharedRedis(): Promise<RedisPort> {
  const { jobsRedisClient } = await import("./queue");
  return (await jobsRedisClient()) as unknown as RedisPort;
}

type RedisPort = {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode: "EX",
    seconds: number,
  ): Promise<unknown>;
};

export type JsonCache = {
  get<T>(key: string): Promise<CacheEntry<T> | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
};

export function createJsonCache(
  getRedis: () => Promise<RedisPort> = sharedRedis,
  now: () => number = Date.now,
): JsonCache {
  return {
    async get<T>(key: string) {
      try {
        const raw = await (await getRedis()).get(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { v: T; t: number };
        return { value: parsed.v, storedAt: parsed.t };
      } catch (error) {
        logger.warn("Cache read failed; treating it as a miss", {
          err: error,
          key,
        });
        return null;
      }
    },
    async set<T>(key: string, value: T, ttlSeconds: number) {
      try {
        await (
          await getRedis()
        ).set(key, JSON.stringify({ v: value, t: now() }), "EX", ttlSeconds);
      } catch (error) {
        logger.warn("Cache write failed; continuing without it", {
          err: error,
          key,
        });
      }
    },
  };
}

export const jsonCache = createJsonCache();
