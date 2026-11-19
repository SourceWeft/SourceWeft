import { DICTATION_LIMITS } from "@sourceweft/contracts/dictation";
import type { RateLimitRule } from "../../shared/rate-limit";

/**
 * One fixed-window rule per user. Dictation posts a short segment every couple
 * of seconds, so the ceiling only has to stop a runaway client, not a person
 * speaking.
 */
export function dictationRateRules(input: { userId: string }): RateLimitRule[] {
  return [
    {
      key: `dictation:user:${input.userId}`,
      limit: DICTATION_LIMITS.requestsPerMinute,
      windowSeconds: 60,
      scope: "minute",
    },
  ];
}

/**
 * At most `DICTATION_LIMITS.maxConcurrent` transcriptions in flight per user.
 * `acquire` returns a release function, or null when the user is already at the
 * limit. A caller must release in a `finally`, and the counter key carries an
 * expiry so a crashed process cannot hold a slot forever.
 */
export type DictationSlots = {
  acquire(userId: string): Promise<(() => Promise<void>) | null>;
};

/** The INCR/EXPIRE pipeline plus the DECR this module issues. */
type SlotsRedisPort = {
  multi(): {
    incr(key: string): unknown;
    expire(key: string, seconds: number): unknown;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
  };
  decr(key: string): Promise<number>;
};

// Long enough to outlast one in-flight segment, short enough that a crashed
// process frees the slot within a minute.
const SLOT_TTL_SECONDS = 60;

/**
 * The shared BullMQ Redis, loaded on first use so that importing this module
 * (in a unit test, say) does not open a connection.
 */
async function sharedRedis(): Promise<SlotsRedisPort> {
  const { jobsRedisClient } = await import("../../shared/queue");
  return (await jobsRedisClient()) as unknown as SlotsRedisPort;
}

export function createDictationSlots(
  getRedis: () => Promise<SlotsRedisPort> = sharedRedis,
): DictationSlots {
  return {
    async acquire(userId) {
      const key = `dictation:inflight:${userId}`;
      const release = async () => {
        const redis = await getRedis();
        await redis.decr(key);
      };

      const redis = await getRedis();
      const pipeline = redis.multi();
      pipeline.incr(key);
      pipeline.expire(key, SLOT_TTL_SECONDS);
      const results = await pipeline.exec();
      for (const [error] of results ?? []) {
        if (error) throw error;
      }

      const count = Number((results?.[0]?.[1] as unknown) ?? 0);
      if (count > DICTATION_LIMITS.maxConcurrent) {
        await release();
        return null;
      }
      return release;
    },
  };
}

export const dictationSlots = createDictationSlots();
