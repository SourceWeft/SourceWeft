import assert from "node:assert/strict";
import { test } from "vitest";
import { buildSearchParts, buildSearchQuery } from "./search-tokenizer";

test("buildSearchParts extracts English and structured code tokens", () => {
  const parts = buildSearchParts(
    "HTTPServerError in source_id at docs/api/search-route.ts",
  );
  const tokens = parts.join(" ").split(/\s+/u);

  assert(tokens.includes("httpservererror"));
  assert(tokens.includes("source_id"));
  assert(tokens.includes("source"));
  assert(tokens.includes("id"));
  assert(tokens.includes("docs/api/search-route.ts"));
  assert(tokens.includes("docs"));
  assert(tokens.includes("api"));
  assert(tokens.includes("search"));
  assert(tokens.includes("route"));
  assert(tokens.includes("ts"));
});

test("buildSearchParts creates CJK bigrams for Chinese", () => {
  const parts = buildSearchParts("机器学习检索系统");
  const tokens = parts.join(" ").split(/\s+/u);

  assert(tokens.includes("机器"));
  assert(tokens.includes("学习"));
  assert(tokens.includes("检索"));
  assert(tokens.includes("系统"));
  assert(tokens.includes("机"));
});

test("buildSearchParts creates CJK bigrams for Japanese", () => {
  const parts = buildSearchParts("検索システムと機械学習");
  const tokens = parts.join(" ").split(/\s+/u);

  assert(tokens.includes("検索"));
  assert(tokens.includes("シス"));
  assert(tokens.includes("機械"));
  assert(tokens.includes("学習"));
});

test("buildSearchQuery keeps single CJK characters searchable", () => {
  assert.equal(buildSearchQuery("检"), "检");
});

test("buildSearchQuery creates searchable Chinese terms", () => {
  const query = buildSearchQuery("机器学习检索");
  const tokens = query.split(/\s+/u);

  assert(tokens.includes("机器"));
  assert(tokens.includes("学习"));
  assert(tokens.includes("检索"));
});

test("buildSearchQuery creates searchable Japanese terms", () => {
  const query = buildSearchQuery("検索システム");
  const tokens = query.split(/\s+/u);

  assert(tokens.includes("検索"));
  assert(tokens.includes("シス"));
});

test("buildSearchQuery handles mixed CJK and English terms", () => {
  const query = buildSearchQuery("NotebookLM 中文 search");
  const tokens = query.split(/\s+/u);

  assert(tokens.includes("notebooklm"));
  assert(tokens.includes("中文"));
  assert(tokens.includes("search"));
});

test("buildSearchQuery returns an empty string for punctuation-only input", () => {
  assert.equal(buildSearchQuery("   - / : ...   "), "");
});

test("buildSearchParts skips exceptionally long tokens", () => {
  const longToken = "a".repeat(129);
  assert.deepEqual(buildSearchParts(longToken), []);
});
