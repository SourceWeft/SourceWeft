import assert from "node:assert/strict";
import test from "node:test";
import { allocateGroupQuotas, splitChunks, splitForCallSize } from "../src/engine/corpus";

test("allocateGroupQuotas sums to the total with at least one per group", () => {
  const cases: [number, number[]][] = [
    [26, [7_000, 7_000, 7_000, 2_000]],
    [13, [9_000, 1_500]],
    [39, [7_000, 6_000, 8_000, 7_500, 7_000, 3_000]],
    [5, [100, 100, 100, 100, 100]],
  ];
  for (const [total, tokens] of cases) {
    const quotas = allocateGroupQuotas(total, tokens);
    assert.equal(quotas.length, tokens.length);
    assert.equal(
      quotas.reduce((a, b) => a + b, 0),
      total,
      `${total} over ${tokens.join(",")}: ${quotas.join(",")}`,
    );
    for (const quota of quotas) {
      assert.ok(quota >= 1);
      assert.ok(quota <= Math.max(1, Math.ceil(total / 2)));
    }
  }
});

test("allocateGroupQuotas gives one per group when there are more groups than items", () => {
  assert.deepEqual(allocateGroupQuotas(2, [100, 100, 100]), [1, 1, 1]);
});

test("allocateGroupQuotas gives a single group the whole total", () => {
  assert.deepEqual(allocateGroupQuotas(26, [7_000]), [26]);
  assert.deepEqual(allocateGroupQuotas(1, [7_000]), [1]);
});

test("splitChunks makes consecutive, non-empty runs of about equal tokens", () => {
  const chunks = [5, 5, 5, 5, 5, 5, 5, 5, 5].map((tokens, id) => ({ id, tokens }));
  const runs = splitChunks(chunks, 3);
  assert.deepEqual(runs.map((run) => run.map((chunk) => chunk.id)), [[0, 1, 2], [3, 4, 5], [6, 7, 8]]);
  // Never more runs than chunks, and every chunk lands in exactly one run.
  assert.equal(splitChunks(chunks.slice(0, 2), 5).length, 2);
  const uneven = [100, 1, 1, 1].map((tokens, id) => ({ id, tokens }));
  assert.deepEqual(splitChunks(uneven, 3).map((run) => run.map((chunk) => chunk.id)), [[0], [1], [2, 3]]);
});

test("splitForCallSize splits only shares above one call, keeps totals and renumbers", () => {
  const chunk = (n: number) => ({ handle: `c${n}`, tokens: 100 }) as never;
  const groups = [
    { index: 0, chunks: [1, 2, 3, 4, 5, 6].map(chunk), tokens: 600 },
    { index: 1, chunks: [7, 8].map(chunk), tokens: 200 },
  ];
  const plan = splitForCallSize(groups, [26, 4], 10);
  assert.deepEqual(plan.quotas, [9, 9, 8, 4]);
  assert.deepEqual(plan.groups.map((group) => group.index), [0, 1, 2, 3]);
  assert.deepEqual(plan.groups.map((group) => group.chunks.length), [2, 2, 2, 2]);
  assert.equal(plan.quotas.reduce((a, b) => a + b, 0), 30);
});
