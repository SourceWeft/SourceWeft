import { jobsRedisClient } from "../../shared/queue";

/**
 * Fixed one-second windows in the shared Redis, so the limit holds across api
 * replicas. Keys expire on their own a second after their window closes.
 */
export type RecordRateLimiter = {
  allow(key: string, limit: number): Promise<boolean>;
};

export const redisRecordRateLimiter: RecordRateLimiter = {
  async allow(key, limit) {
    const window = Math.floor(Date.now() / 1000);
    const redisKey = `artifact-records:rate:${key}:${window}`;
    const redis = await jobsRedisClient();
    const results = await redis
      .multi()
      .incr(redisKey)
      .expire(redisKey, 2)
      .exec();
    const [error, value] = results?.[0] ?? [];
    if (error) throw error;
    return Number(value) <= limit;
  },
};
