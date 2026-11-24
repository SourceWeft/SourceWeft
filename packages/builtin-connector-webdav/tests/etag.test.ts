import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEtag } from "../src/etag";

test("normalizeEtag strips quotes, the weak prefix and a content-coding suffix", () => {
  // WsgiDAV reports PROPFIND getetag unquoted and the GET ETag quoted.
  assert.equal(normalizeEtag("abc123"), "abc123");
  assert.equal(normalizeEtag('"abc123"'), "abc123");
  // A gzip/brotli-aware server weakens or suffixes the tag.
  assert.equal(normalizeEtag('W/"abc123"'), "abc123");
  assert.equal(normalizeEtag('"abc123-gzip"'), "abc123");
  assert.equal(normalizeEtag('"abc123-br"'), "abc123");
  assert.equal(normalizeEtag('W/"abc123-gzip"'), "abc123");
});

test("normalizeEtag returns null for an absent or empty tag", () => {
  assert.equal(normalizeEtag(null), null);
  assert.equal(normalizeEtag(undefined), null);
  assert.equal(normalizeEtag(""), null);
  assert.equal(normalizeEtag("   "), null);
  assert.equal(normalizeEtag('""'), null);
});

test("normalizeEtag keeps a hyphen that is not a coding token", () => {
  assert.equal(normalizeEtag('"a-b-c"'), "a-b-c");
  assert.equal(normalizeEtag('"abc-gzipx"'), "abc-gzipx");
});
