import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { planSitemapShards } from "./planner";

test("covers more than 50,000 records exactly once and splits dense buckets", async () => {
  const hashes = Array.from({ length: 90_123 }, (_, i) =>
    createHash("md5").update(String(i)).digest("hex"),
  );
  const shards = await planSitemapShards(async (prefix) => {
    const counts = new Map<string, number>();
    for (const hash of hashes)
      if (hash.startsWith(prefix)) {
        const child = hash.slice(0, prefix.length + 1);
        counts.set(child, (counts.get(child) ?? 0) + 1);
      }
    return [...counts].map(([prefix, count]) => ({ prefix, count }));
  });
  expect(shards.reduce((n, s) => n + s.count, 0)).toBe(hashes.length);
  expect(shards.every((s) => s.count <= 5000)).toBe(true);
  expect(shards.some((s) => s.prefix.length > 1)).toBe(true);
  const prefixes = new Set(shards.map((s) => s.prefix));
  let uncovered = 0,
    repeated = 0;
  for (const hash of hashes) {
    let matches = 0;
    for (let length = 1; length <= 32; length++)
      if (prefixes.has(hash.slice(0, length))) matches++;
    if (matches === 0) uncovered++;
    if (matches > 1) repeated++;
  }
  expect({ uncovered, repeated }).toEqual({ uncovered: 0, repeated: 0 });
});
test("does not return partial index on a source failure or invalid buckets", async () => {
  await expect(
    planSitemapShards(async (prefix) => {
      if (!prefix) return [{ prefix: "a", count: 5001 }];
      throw new Error("offline");
    }),
  ).rejects.toThrow("offline");
  await expect(
    planSitemapShards(async () => [{ prefix: "z", count: 1 }]),
  ).rejects.toThrow("Invalid");
  await expect(
    planSitemapShards(async () => [
      { prefix: "a", count: 1 },
      { prefix: "a", count: 1 },
    ]),
  ).rejects.toThrow("Invalid");
});
test("empty catalogs are valid; unsplittable buckets fail instead of truncating", async () => {
  expect(await planSitemapShards(async () => [])).toEqual([]);
  await expect(
    planSitemapShards(async (prefix) => [
      { prefix: prefix + "a", count: 5001 },
    ]),
  ).rejects.toThrow("cannot be split");
});
