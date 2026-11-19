import assert from "node:assert/strict";
import test from "node:test";
import { allocateGroupQuotas } from "../src/engine/corpus";

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
