import assert from "node:assert/strict";
import { test } from "vitest";
import { chunk } from "./chunk";

test("an empty input yields no chunks", () => {
  assert.deepEqual(chunk([], 3), []);
});

test("an exact multiple splits into full chunks only", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5, 6], 3), [
    [1, 2, 3],
    [4, 5, 6],
  ]);
});

test("a remainder becomes a shorter last chunk, and a short input is one chunk", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5, 6, 7], 3), [
    [1, 2, 3],
    [4, 5, 6],
    [7],
  ]);
  assert.deepEqual(chunk(["a", "b"], 5), [["a", "b"]]);
});

test("the size must be a positive integer", () => {
  for (const size of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => chunk([1, 2], size), RangeError, String(size));
  }
});
