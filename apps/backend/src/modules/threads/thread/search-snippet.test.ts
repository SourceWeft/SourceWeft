import assert from "node:assert/strict";
import { test } from "vitest";
import { buildSearchSnippet } from "./search-snippet";

test("short text is returned whole with whitespace collapsed", () => {
  assert.equal(buildSearchSnippet("  hello\n\n  world  ", "world"), "hello world");
});

test("long text is cut around the hit with ellipses on cut sides", () => {
  const text = `${"a ".repeat(100)}NEEDLE${" b".repeat(100)}`;
  const snippet = buildSearchSnippet(text, "needle", 40);
  assert.ok(snippet.includes("NEEDLE"));
  assert.ok(snippet.startsWith("…"));
  assert.ok(snippet.endsWith("…"));
  assert.ok(snippet.length <= 42);
});

test("a hit at the start has no leading ellipsis", () => {
  const snippet = buildSearchSnippet(`needle ${"x".repeat(300)}`, "needle", 40);
  assert.ok(snippet.startsWith("needle"));
  assert.ok(snippet.endsWith("…"));
});

test("CJK text is cut around the hit", () => {
  const text = `${"前文".repeat(100)}归档功能${"后文".repeat(100)}`;
  const snippet = buildSearchSnippet(text, "归档", 30);
  assert.ok(snippet.includes("归档功能"));
});

test("a missing hit falls back to the start", () => {
  const snippet = buildSearchSnippet("x".repeat(300), "nothing", 40);
  assert.ok(snippet.startsWith("x"));
  assert.ok(snippet.endsWith("…"));
});
