import { expect, test } from "vitest";
import type { AccrualRedisPort } from "./accrual";
import { createDictationAccrual, dictationAccountKey } from "./accrual";

/**
 * An in-memory stand-in for the shared Redis, just large enough to back the
 * three commands this module issues. `multi()` queues operations and runs
 * them synchronously inside `exec()` (no `await` in between), the same way a
 * real `MULTI`/`EXEC` pipeline applies its commands as one atomic step.
 */
function createFakeRedis(): AccrualRedisPort {
  const store = new Map<string, string>();

  return {
    async set(key, value, _expireFlag, _seconds, _setFlag) {
      if (store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    multi() {
      const ops: Array<() => [Error | null, unknown]> = [];
      return {
        incrbyfloat(key: string, increment: number) {
          ops.push(() => {
            const current = Number.parseFloat(store.get(key) ?? "0");
            const next = current + increment;
            store.set(key, String(next));
            return [null, String(next)];
          });
        },
        expire(_key: string, _seconds: number) {
          ops.push(() => [null, 1]);
        },
        get(key: string) {
          ops.push(() => [null, store.get(key) ?? null]);
        },
        del(key: string) {
          ops.push(() => {
            store.delete(key);
            return [null, 1];
          });
        },
        async exec() {
          return ops.map((op) => op());
        },
      };
    },
  };
}

test("a segment with the same digest is counted once", async () => {
  const redis = createFakeRedis();
  const accrual = createDictationAccrual(async () => redis);

  expect(await accrual.markSegment("session-1", 0, "digest-a")).toBe(true);
  expect(await accrual.markSegment("session-1", 0, "digest-a")).toBe(false);
});

test("different audio digests under one (session, seq) are each counted", async () => {
  const redis = createFakeRedis();
  const accrual = createDictationAccrual(async () => redis);

  expect(await accrual.markSegment("session-1", 0, "digest-a")).toBe(true);
  // Different bytes reusing the same pair: a fresh sighting, not a retry.
  expect(await accrual.markSegment("session-1", 0, "digest-b")).toBe(true);
  expect(await accrual.markSegment("session-1", 0, "digest-b")).toBe(false);
});

test("add returns the running total", async () => {
  const redis = createFakeRedis();
  const accrual = createDictationAccrual(async () => redis);
  const accountKey = dictationAccountKey({ teamId: "team-1", userId: "user-1" });

  expect(await accrual.add(accountKey, 120.5)).toBeCloseTo(120.5, 3);
  expect(await accrual.add(accountKey, 180)).toBeCloseTo(300.5, 3);
});

test("take returns everything and leaves nothing", async () => {
  const redis = createFakeRedis();
  const accrual = createDictationAccrual(async () => redis);
  const accountKey = dictationAccountKey({ teamId: "team-1", userId: "user-1" });

  await accrual.add(accountKey, 300.5);
  expect(await accrual.take(accountKey)).toBeCloseTo(300.5, 3);
  expect(await accrual.take(accountKey)).toBe(0);
});

test("concurrent takes hand the seconds to exactly one caller", async () => {
  const redis = createFakeRedis();
  const accrual = createDictationAccrual(async () => redis);
  const accountKey = dictationAccountKey({ teamId: "team-1", userId: "user-1" });

  await accrual.add(accountKey, 300.5);
  const [first, second] = await Promise.all([
    accrual.take(accountKey),
    accrual.take(accountKey),
  ]);

  const results = [first, second].sort((a, b) => a - b);
  expect(results[0]).toBe(0);
  expect(results[1]).toBeCloseTo(300.5, 3);
});

test("restore puts seconds back", async () => {
  const redis = createFakeRedis();
  const accrual = createDictationAccrual(async () => redis);
  const accountKey = dictationAccountKey({ teamId: "team-1", userId: "user-1" });

  await accrual.add(accountKey, 10);
  expect(await accrual.take(accountKey)).toBeCloseTo(10, 3);

  await accrual.restore(accountKey, 10);
  expect(await accrual.take(accountKey)).toBeCloseTo(10, 3);
});

test("account keys differ by user and by team", () => {
  const base = dictationAccountKey({ teamId: "team-1", userId: "user-1" });

  expect(dictationAccountKey({ teamId: "team-1", userId: "user-2" })).not.toBe(
    base,
  );
  expect(dictationAccountKey({ teamId: "team-2", userId: "user-1" })).not.toBe(
    base,
  );
  expect(base).toBe("dictation:accrual:team-1:user-1");
});
