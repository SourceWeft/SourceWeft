import assert from "node:assert/strict";
import { test } from "vitest";
import { createSkillReadBudget } from "./read-budget";
test("large retained bundles wait until release, release is idempotent", async () => {
  const reserve = createSkillReadBudget(10),
    signal = new AbortController().signal;
  const release = await reserve(8, signal);
  let entered = false;
  const pending = reserve(5, signal).then((r) => {
    entered = true;
    return r;
  });
  await Promise.resolve();
  assert.equal(entered, false);
  release();
  release();
  const second = await pending;
  assert.equal(entered, true);
  second();
  (await reserve(10, signal))();
});
test("aborted waiting imports do not consume capacity or block later work", async () => {
  const reserve = createSkillReadBudget(10),
    first = new AbortController(),
    waiting = new AbortController();
  const release = await reserve(10, first.signal);
  const pending = reserve(1, waiting.signal);
  waiting.abort(new Error("deadline"));
  await assert.rejects(pending, /deadline/);
  release();
  (await reserve(10, first.signal))();
});
