import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGrepGlobMatcher,
  matchesGrepGlob,
  normalizeGrepGlobPattern,
} from "./database-fs-backend";

test("normalizeGrepGlobPattern anchors relative glob to grep path", () => {
  assert.equal(normalizeGrepGlobPattern("*.md", "/kb"), "/kb/*.md");
  assert.equal(
    normalizeGrepGlobPattern("*.md", "/kb/source__src_12345678"),
    "/kb/source__src_12345678/*.md",
  );
});

test("buildGrepGlobMatcher lets source-file globs select chunk-backed content", () => {
  const matcher = buildGrepGlobMatcher("*.md", "/kb");

  assert.equal(matcher.test("/kb/invoice__src_12345678.md"), true);
  assert.equal(matcher.test("/kb/invoice__src_12345678/chunks/0000.md"), false);
  assert.equal(
    matchesGrepGlob({
      glob: "*.md",
      globMatcher: matcher,
      sourceFilePath: "/kb/invoice__src_12345678.md",
      chunkPath: "/kb/invoice__src_12345678/chunks/0000.md",
    }),
    true,
  );
});

test("buildGrepGlobMatcher treats bare star as the current grep scope", () => {
  const matcher = buildGrepGlobMatcher("*", "/kb");

  assert.equal(normalizeGrepGlobPattern("*", "/kb"), "**");
  assert.equal(matcher.test("/kb/invoice__src_12345678.md"), true);
  assert.equal(matcher.test("/kb/invoice__src_12345678/chunks/0000.md"), true);
  assert.equal(
    matchesGrepGlob({
      glob: "*",
      globMatcher: matcher,
      sourceFilePath: "/kb/invoice__src_12345678.md",
      chunkPath: "/kb/invoice__src_12345678/chunks/0000.md",
    }),
    true,
  );
});

test("buildGrepGlobMatcher does not expose original source title aliases", () => {
  const matcher = buildGrepGlobMatcher("*.pdf", "/kb");

  assert.equal(normalizeGrepGlobPattern("*.pdf", "/kb"), "/kb/*.pdf");
  assert.equal(matcher.test("/kb/invoice.pdf"), true);
  assert.equal(matcher.test("/kb/invoice__src_12345678.md"), false);
  assert.equal(
    matchesGrepGlob({
      glob: "*.pdf",
      globMatcher: matcher,
      sourceFilePath: "/kb/invoice__src_12345678.md",
      chunkPath: "/kb/invoice__src_12345678/chunks/0000.md",
    }),
    false,
  );
});

test("buildGrepGlobMatcher preserves recursive chunk globs", () => {
  const matcher = buildGrepGlobMatcher("**/*.md", "/kb");

  assert.equal(matcher.test("/kb/invoice__src_12345678.md"), true);
  assert.equal(matcher.test("/kb/invoice__src_12345678/chunks/0000.md"), true);
});

test("buildGrepGlobMatcher keeps non-matching globs selective", () => {
  const matcher = buildGrepGlobMatcher("contract*.md", "/kb");

  assert.equal(matcher.test("/kb/invoice__src_12345678.md"), false);
  assert.equal(
    matchesGrepGlob({
      glob: "contract*.md",
      globMatcher: matcher,
      sourceFilePath: "/kb/invoice__src_12345678.md",
      chunkPath: "/kb/invoice__src_12345678/chunks/0000.md",
    }),
    false,
  );
});

test("matchesGrepGlob allows all chunks when glob is omitted", () => {
  const matcher = buildGrepGlobMatcher(null, "/kb");

  assert.equal(
    matchesGrepGlob({
      glob: null,
      globMatcher: matcher,
      sourceFilePath: "/kb/invoice__src_12345678.md",
      chunkPath: "/kb/invoice__src_12345678/chunks/0000.md",
    }),
    true,
  );
});
