import assert from "node:assert/strict";
import { test } from "vitest";
import { createJsonCache } from "./redis-cache";

function memoryRedis() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    ttls,
    redis: {
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async set(key: string, value: string, _mode: "EX", seconds: number) {
        store.set(key, value);
        ttls.set(key, seconds);
      },
    },
  };
}

test("a stored value is returned with the time it was stored", async () => {
  const { redis, ttls } = memoryRedis();
  const cache = createJsonCache(
    async () => redis,
    () => 1234,
  );

  await cache.set("k", { a: [1, 2] }, 60);

  assert.deepEqual(await cache.get("k"), {
    value: { a: [1, 2] },
    storedAt: 1234,
  });
  assert.equal(ttls.get("k"), 60);
});

test("a missing key is a miss", async () => {
  const { redis } = memoryRedis();
  assert.equal(await createJsonCache(async () => redis).get("nope"), null);
});

test("a Redis failure is a miss on read and does not throw on write", async () => {
  const broken = createJsonCache(async () => {
    throw new Error("redis down");
  });

  assert.equal(await broken.get("k"), null);
  await assert.doesNotReject(broken.set("k", 1, 10));
});

test("an unreadable stored value is a miss", async () => {
  const redis = {
    async get() {
      return "{not json";
    },
    async set() {},
  };
  assert.equal(await createJsonCache(async () => redis).get("k"), null);
});
