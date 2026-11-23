import assert from "node:assert/strict";
import test from "node:test";
import { coverageFirst } from "../src/engine/coverage";

test("sections take turns, each keeping its own order", () => {
  const items = ["a1", "a2", "a3", "b1", "c1", "c2"];
  assert.deepEqual(
    coverageFirst(items, (item) => item[0]!),
    ["a1", "b1", "c1", "a2", "c2", "a3"],
  );
});

test("one section, or none, keeps the original order", () => {
  assert.deepEqual(coverageFirst(["x1", "x2", "x3"], () => "x"), ["x1", "x2", "x3"]);
  assert.deepEqual(coverageFirst([], () => "x"), []);
});
