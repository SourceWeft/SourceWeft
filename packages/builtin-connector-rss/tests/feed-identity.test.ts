import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  canonicalLink,
  contentHashOf,
  itemIdentity,
} from "../src/feed-identity";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

test("canonicalLink drops the fragment and utm_* params and keeps the rest", () => {
  assert.equal(
    canonicalLink("https://a.example/p?utm_source=x&id=1#frag"),
    "https://a.example/p?id=1",
  );
  assert.equal(
    canonicalLink("http://A.example/p?UTM_Campaign=x&utm_medium=y#f"),
    "http://a.example/p",
  );
});

test("canonicalLink accepts only valid http and https URLs", () => {
  assert.equal(canonicalLink("javascript:alert(1)"), null);
  assert.equal(canonicalLink("ftp://a.example/x"), null);
  assert.equal(canonicalLink("/relative/path"), null);
  assert.equal(canonicalLink("not a url"), null);
  assert.equal(canonicalLink(""), null);
});

test("itemIdentity prefers the trimmed guid", () => {
  assert.equal(
    itemIdentity({
      guid: "  post-1 ",
      link: "https://a.example/p",
      title: "t",
      date: null,
    }),
    "post-1",
  );
});

test("an over-long guid is hashed, not truncated", () => {
  const long = "g".repeat(257);
  assert.equal(
    itemIdentity({ guid: long, link: null, title: "t", date: null }),
    `h:${sha256(long)}`,
  );
  const exact = "g".repeat(256);
  assert.equal(
    itemIdentity({ guid: exact, link: null, title: "t", date: null }),
    exact,
  );
});

test("without a guid the canonical link is the identity", () => {
  assert.equal(
    itemIdentity({
      guid: " ",
      link: "https://a.example/p?utm_source=x&id=1#f",
      title: "t",
      date: null,
    }),
    "https://a.example/p?id=1",
  );
});

test("without guid or usable link the identity hashes title and ISO date", () => {
  const date = new Date("2025-11-03T11:00:00Z");
  assert.equal(
    itemIdentity({ guid: null, link: null, title: "Hello", date }),
    `h:${sha256("Hello|2025-11-03T11:00:00.000Z")}`,
  );
  assert.equal(
    itemIdentity({
      guid: null,
      link: "javascript:x",
      title: "Hello",
      date: null,
    }),
    `h:${sha256("Hello|")}`,
  );
});

const base = {
  title: "T",
  link: "https://a.example/p",
  author: "A",
  publishedAt: new Date("2025-11-03T11:00:00Z"),
  updatedAt: new Date("2025-11-04T11:00:00Z"),
  text: "body",
};

test("contentHashOf is a sha256 hex digest that changes with the text", () => {
  const hash = contentHashOf(base);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, contentHashOf({ ...base, text: "body 2" }));
  assert.notEqual(hash, contentHashOf({ ...base, title: "T2" }));
  assert.notEqual(hash, contentHashOf({ ...base, author: null }));
});

test("contentHashOf ignores how a date was written, only the instant", () => {
  const sameInstant = new Date("2025-11-04T13:00:00+02:00");
  assert.equal(
    contentHashOf(base),
    contentHashOf({ ...base, updatedAt: sameInstant }),
  );
  assert.equal(contentHashOf(base), contentHashOf({ ...base }));
});

test("contentHashOf does not confuse field boundaries", () => {
  assert.notEqual(
    contentHashOf({ ...base, title: "ab", author: "c" }),
    contentHashOf({ ...base, title: "a", author: "bc" }),
  );
});
