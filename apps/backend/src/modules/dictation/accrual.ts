/**
 * Dictation segments are cheap and frequent, so each one is not settled on
 * its own. Instead the audio seconds it cost accrue in the shared Redis
 * against the team+user that spoke them, and a single settlement charges the
 * running total once it crosses `DICTATION_SETTLE_THRESHOLD_SECONDS` (or the
 * session ends). This keeps the billing ledger from writing one entry per
 * segment while still charging for every second spoken.
 */

const SEEN_TTL_SECONDS = 30 * 60; // 30 minutes: long enough to outlast a retry.
const ACCRUAL_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days from the last add.

export const DICTATION_SETTLE_THRESHOLD_SECONDS = 300;

export type DictationAccrual = {
  /** True the first time a (session, seq) is seen; false for a repeat. Remembered for 30 minutes. */
  markSegment(sessionId: string, seq: number): Promise<boolean>;
  /** Adds seconds and returns the new total. The key expires 30 days after the last add. */
  add(accountKey: string, seconds: number): Promise<number>;
  /** Returns the accrued seconds and clears them, as one atomic step. 0 when empty. */
  take(accountKey: string): Promise<number>;
  restore(accountKey: string, seconds: number): Promise<void>;
};

/**
 * The shared Redis commands this module needs, narrowed to one `SET ... NX`
 * call and the two `MULTI`/`EXEC` pipelines (`INCRBYFLOAT`+`EXPIRE`, then
 * `GET`+`DEL`) so a test can pass an in-memory fake instead of a real client.
 */
export type AccrualRedisPort = {
  set(
    key: string,
    value: string,
    expireFlag: "EX",
    seconds: number,
    setFlag: "NX",
  ): Promise<"OK" | null>;
  multi(): {
    incrbyfloat(key: string, increment: number): unknown;
    expire(key: string, seconds: number): unknown;
    get(key: string): unknown;
    del(key: string): unknown;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
  };
};

/**
 * The shared BullMQ Redis, loaded on first use so that importing this module
 * (in a unit test, say) does not open a connection.
 */
async function sharedRedis(): Promise<AccrualRedisPort> {
  const { jobsRedisClient } = await import("../../shared/queue");
  return (await jobsRedisClient()) as unknown as AccrualRedisPort;
}

function toSeconds(value: unknown): number {
  if (typeof value === "string") return Number.parseFloat(value);
  if (typeof value === "number") return value;
  return 0;
}

function throwOnPipelineError(
  results: Array<[Error | null, unknown]> | null,
): Array<[Error | null, unknown]> {
  const settled = results ?? [];
  for (const [error] of settled) {
    if (error) throw error;
  }
  return settled;
}

export function dictationAccountKey(input: {
  teamId: string;
  userId: string;
}): string {
  return `dictation:accrual:${input.teamId}:${input.userId}`;
}

export function createDictationAccrual(
  getRedis: () => Promise<AccrualRedisPort> = sharedRedis,
): DictationAccrual {
  async function add(accountKey: string, seconds: number): Promise<number> {
    const redis = await getRedis();
    const pipeline = redis.multi();
    pipeline.incrbyfloat(accountKey, seconds);
    pipeline.expire(accountKey, ACCRUAL_TTL_SECONDS);
    const results = throwOnPipelineError(await pipeline.exec());
    return toSeconds(results[0]?.[1]);
  }

  return {
    async markSegment(sessionId, seq) {
      const redis = await getRedis();
      const key = `dictation:seen:${sessionId}:${seq}`;
      const result = await redis.set(key, "1", "EX", SEEN_TTL_SECONDS, "NX");
      return result === "OK";
    },

    add,

    async take(accountKey) {
      const redis = await getRedis();
      const pipeline = redis.multi();
      pipeline.get(accountKey);
      pipeline.del(accountKey);
      const results = throwOnPipelineError(await pipeline.exec());
      return toSeconds(results[0]?.[1]);
    },

    async restore(accountKey, seconds) {
      await add(accountKey, seconds);
    },
  };
}

export const dictationAccrual = createDictationAccrual();
