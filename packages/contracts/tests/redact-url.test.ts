import assert from "node:assert/strict";
import test from "node:test";
import { redactUrlQuery } from "../src/redact-url";

test("redactUrlQuery strips userinfo, query and fragment", () => {
  assert.equal(
    redactUrlQuery("https://u:p@Example.com:8443/a/b?token=SECRET#x"),
    "https://example.com:8443/a/b",
  );
});

test("redactUrlQuery keeps a plain http url", () => {
  assert.equal(
    redactUrlQuery("http://example.com/feed.xml"),
    "http://example.com/feed.xml",
  );
});

test("redactUrlQuery returns an empty string for a non-url", () => {
  assert.equal(redactUrlQuery("not a url"), "");
});

test("redactUrlQuery returns an empty string for a non-http scheme", () => {
  assert.equal(redactUrlQuery("ftp://x/y"), "");
});
