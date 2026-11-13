import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mapWithConcurrency,
  truncateMarkdown,
  wordCount,
} from "../src/providers/shared";

test("truncateMarkdown leaves short text untouched", () => {
  assert.deepEqual(truncateMarkdown("abc", 10), { markdown: "abc", truncated: false });
});

test("truncateMarkdown cuts long text to the limit and flags it", () => {
  const result = truncateMarkdown("x".repeat(50), 10);
  assert.equal(result.truncated, true);
  assert.ok(result.markdown.length <= 10);
});

test("wordCount counts whitespace-separated words", () => {
  assert.equal(wordCount("  a  b\n c "), 3);
  assert.equal(wordCount(""), 0);
});

test("mapWithConcurrency caps active mappers and preserves order", async () => {
  let active = 0;
  let maxActive = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return item * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40, 50, 60]);
  assert.equal(maxActive, 2);
});
