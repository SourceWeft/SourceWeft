import assert from "node:assert/strict";
import test from "node:test";
import { WebDavError } from "../src/errors";
import {
  isStrictDescendant,
  normalizePath,
  normalizeRoot,
  samePath,
  toExternalId,
  toRequestUrl,
} from "../src/paths";

const base = new URL("https://cloud.example.com/remote.php/dav/files/alice/");

test("normalizeRoot collapses slashes, adds a leading and trailing slash", () => {
  const cases: Array<[string, string]> = [
    ["/", "/"],
    ["", "/"],
    ["Documents", "/Documents/"],
    ["/Documents", "/Documents/"],
    ["/Documents/", "/Documents/"],
    ["//Documents///Reports//", "/Documents/Reports/"],
    ["/a/./b", "/a/b/"],
    ["/My Files/Q1 (final)", "/My Files/Q1 (final)/"],
    ["/100%25/ünï/日本語", "/100%25/ünï/日本語/"],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(normalizeRoot(raw), expected, JSON.stringify(raw));
  }
});

test("normalizeRoot and normalizePath reject traversal and control characters", () => {
  const cases = [
    "/..",
    "/a/../b",
    "../a",
    "/a/..",
    "/a/b/../../..",
    "/a\u0000b",
    "/a\nb",
    "/a\\..\\b",
    `/${"x".repeat(600)}`,
  ];
  for (const raw of cases) {
    assert.throws(
      () => normalizeRoot(raw),
      (error: unknown) =>
        error instanceof WebDavError && error.code === "WEBDAV_PATH_INVALID",
      JSON.stringify(raw),
    );
  }
  assert.throws(() => normalizePath("/a/../b"), WebDavError);
});

test("normalizePath keeps a file path without forcing a trailing slash", () => {
  assert.equal(normalizePath("/a//b.txt"), "/a/b.txt");
  assert.equal(normalizePath("/a/b/"), "/a/b/");
  assert.equal(normalizePath(""), "/");
});

test("toExternalId decodes an href once and strips the endpoint base path", () => {
  const cases: Array<[string, string | null]> = [
    ["/remote.php/dav/files/alice/Documents/a.txt", "/Documents/a.txt"],
    ["/remote.php/dav/files/alice/Documents/", "/Documents"],
    ["/remote.php/dav/files/alice/Documents", "/Documents"],
    ["/remote.php/dav/files/alice/", "/"],
    ["/remote.php/dav/files/alice", "/"],
    // percent-decoded exactly once
    ["/remote.php/dav/files/alice/My%20Files/a%20b.txt", "/My Files/a b.txt"],
    ["/remote.php/dav/files/alice/100%2525/a.txt", "/100%25/a.txt"],
    ["/remote.php/dav/files/alice/%E6%97%A5%E6%9C%AC/a.txt", "/日本/a.txt"],
    // collapsed duplicate slashes
    ["/remote.php/dav/files/alice//Documents///a.txt", "/Documents/a.txt"],
    // absolute href on the same origin
    [
      "https://cloud.example.com/remote.php/dav/files/alice/Documents/a.txt",
      "/Documents/a.txt",
    ],
    // different origin, different scheme, different port
    ["https://evil.example.com/remote.php/dav/files/alice/a.txt", null],
    ["http://cloud.example.com/remote.php/dav/files/alice/a.txt", null],
    ["https://cloud.example.com:8443/remote.php/dav/files/alice/a.txt", null],
    // outside the base path
    ["/remote.php/dav/files/bob/a.txt", null],
    ["/remote.php/dav/files/", null],
    ["/other/Documents/a.txt", null],
    ["/remote.php/dav/files/alicea/a.txt", null],
    // traversal, raw and encoded
    ["/remote.php/dav/files/alice/../bob/a.txt", null],
    ["/remote.php/dav/files/alice/a/../b.txt", null],
    ["/remote.php/dav/files/alice/./a.txt", null],
    ["Documents/a.txt", null],
    ["/remote.php/dav/files/alice/%2e%2e/bob/a.txt", null],
    ["/remote.php/dav/files/alice/a/..%2f..%2fbob/a.txt", null],
    // an encoded slash inside one segment is not a path separator
    ["/remote.php/dav/files/alice/a%2Fb/c.txt", null],
    ["/remote.php/dav/files/alice/a%5Cb.txt", null],
    // malformed percent-encoding, NUL
    ["/remote.php/dav/files/alice/%E0%A4%A", null],
    ["/remote.php/dav/files/alice/a%00b", null],
    ["", null],
  ];
  for (const [href, expected] of cases) {
    assert.equal(toExternalId(base, href), expected, JSON.stringify(href));
  }
});

test("toExternalId works for an endpoint at the server root", () => {
  const root = new URL("https://dav.example.com/");
  assert.equal(toExternalId(root, "/a/b.txt"), "/a/b.txt");
  assert.equal(toExternalId(root, "/"), "/");
});

test("toExternalId treats an endpoint base path made of encoded characters", () => {
  const encoded = new URL("https://h.example/My%20Files/dav/");
  assert.equal(toExternalId(encoded, "/My%20Files/dav/x/a.txt"), "/x/a.txt");
  assert.equal(toExternalId(encoded, "/My Files/dav/x/a.txt"), "/x/a.txt");
  assert.equal(toExternalId(encoded, "/Other/dav/x/a.txt"), null);
});

test("samePath ignores a trailing slash and nothing else", () => {
  assert.equal(samePath("/a/b", "/a/b/"), true);
  assert.equal(samePath("/a/b/", "/a/b/"), true);
  assert.equal(samePath("/", "/"), true);
  assert.equal(samePath("/a/b", "/a/c"), false);
  assert.equal(samePath("/a/b", "/A/b"), false);
});

test("toRequestUrl percent-encodes each segment under the endpoint", () => {
  assert.equal(
    toRequestUrl(base, "/My Files/a b#1?.txt"),
    "https://cloud.example.com/remote.php/dav/files/alice/My%20Files/a%20b%231%3F.txt",
  );
  assert.equal(
    toRequestUrl(base, "/Documents/"),
    "https://cloud.example.com/remote.php/dav/files/alice/Documents/",
  );
  assert.equal(toRequestUrl(base, "/"), base.href);
  assert.equal(
    toRequestUrl(base, "/100%25/日本"),
    "https://cloud.example.com/remote.php/dav/files/alice/100%2525/%E6%97%A5%E6%9C%AC",
  );
});

test("toRequestUrl round-trips through toExternalId", () => {
  for (const path of ["/a b/c.txt", "/100%25/x", "/日本/é.md", "/q?/#h/z"]) {
    const url = toRequestUrl(base, path);
    assert.equal(toExternalId(base, new URL(url).pathname), path);
  }
});

test("toRequestUrl refuses a path that escapes the endpoint", () => {
  assert.throws(() => toRequestUrl(base, "/a/../../etc"), WebDavError);
});

test("isStrictDescendant matches segment-wise, never by string prefix", () => {
  // Strict descendants (trailing slash on the ancestor is irrelevant).
  assert.equal(isStrictDescendant("/a/b/", "/a/b/c"), true);
  assert.equal(isStrictDescendant("/a/b", "/a/b/c/d"), true);
  assert.equal(isStrictDescendant("/", "/x"), true);
  // The collection's own self entry is not its descendant.
  assert.equal(isStrictDescendant("/a/b/", "/a/b"), false);
  assert.equal(isStrictDescendant("/a/b/", "/a/b/"), false);
  // Parent, sibling and an outside path are rejected.
  assert.equal(isStrictDescendant("/a/b/", "/a"), false);
  assert.equal(isStrictDescendant("/a/b/", "/a/sibling"), false);
  assert.equal(isStrictDescendant("/a/b/", "/zzz/x"), false);
  // A prefix lookalike is rejected: /a/bc is not under /a/b.
  assert.equal(isStrictDescendant("/a/b/", "/a/bc"), false);
  assert.equal(isStrictDescendant("/a/b/", "/a/bc/d"), false);
});
