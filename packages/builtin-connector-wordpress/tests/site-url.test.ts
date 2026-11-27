import assert from "node:assert/strict";
import test from "node:test";
import { WordPressError } from "../src/errors";
import { parseSiteUrl, siteHostOf } from "../src/site-url";

test("accepts a plain host and returns it unchanged", () => {
  assert.equal(parseSiteUrl("https://example.com"), "https://example.com");
});

test("lowercases the host and trims one trailing slash", () => {
  assert.equal(parseSiteUrl("https://Example.COM/"), "https://example.com");
  assert.equal(
    parseSiteUrl("https://Example.com/Blog/News/"),
    "https://example.com/Blog/News",
  );
});

test("accepts a punycode host and a dotted subfolder name", () => {
  assert.equal(
    parseSiteUrl("https://xn--e1afmkfd.xn--p1ai"),
    "https://xn--e1afmkfd.xn--p1ai",
  );
  assert.equal(
    parseSiteUrl("https://x.example.org/v1.2/blog_a~b"),
    "https://x.example.org/v1.2/blog_a~b",
  );
});

test("the 512-character limit is inclusive", () => {
  const head = "https://example.com/";
  const ok = head + "a".repeat(512 - head.length);
  assert.equal(ok.length, 512);
  assert.equal(parseSiteUrl(ok), ok.replace(/\/$/, ""));
  assert.throws(
    () => parseSiteUrl(`${ok}a`),
    (e: unknown) =>
      e instanceof WordPressError && e.code === "SITE_URL_INVALID",
  );
});

const REJECTED: [string, unknown][] = [
  ["not a string: null", null],
  ["not a string: number", 5],
  ["empty", ""],
  ["http", "http://example.com"],
  ["other scheme", "ftp://example.com"],
  ["no scheme", "example.com"],
  ["uppercase scheme", "HTTPS://example.com"],
  ["leading whitespace", " https://example.com"],
  ["trailing whitespace", "https://example.com "],
  ["IPv4", "https://127.0.0.1"],
  ["IPv4 with path", "https://192.168.1.1/blog"],
  ["public IPv4", "https://8.8.8.8"],
  ["decimal host", "https://2130706433"],
  ["hex host", "https://0x7f000001"],
  ["dotted hex host", "https://0x7f.0x0.0x0.0x1"],
  ["octal-ish host", "https://0177.0.0.1"],
  ["bracketed IPv6", "https://[::1]"],
  ["bracketed IPv6 with path", "https://[2001:db8::1]/blog"],
  ["localhost", "https://localhost"],
  ["localhost uppercase", "https://LOCALHOST"],
  ["localhost subdomain", "https://site.localhost"],
  ["local suffix", "https://site.local"],
  ["internal suffix", "https://site.internal"],
  ["single label", "https://intranet"],
  ["empty label", "https://example..com"],
  ["leading dot", "https://.example.com"],
  ["trailing dot", "https://example.com."],
  ["leading hyphen label", "https://-a.example.com"],
  ["trailing hyphen label", "https://a-.example.com"],
  ["underscore host", "https://a_b.example.com"],
  ["non-ascii host", "https://münchen.example.com"],
  ["label over 63", `https://${"a".repeat(64)}.example.com`],
  ["host over 253", `https://${"a.".repeat(130)}com`],
  ["port", "https://example.com:8443"],
  ["port with path", "https://example.com:443/blog"],
  ["userinfo", "https://user:pass@example.com"],
  ["user only", "https://user@example.com"],
  ["query", "https://example.com/?a=1"],
  ["empty query", "https://example.com/blog?"],
  ["fragment", "https://example.com/#top"],
  ["empty fragment", "https://example.com/blog#"],
  ["dot segment", "https://example.com/."],
  ["dot-dot segment", "https://example.com/.."],
  ["dot-dot in the middle", "https://example.com/a/../b"],
  ["dot in the middle", "https://example.com/a/./b"],
  ["double slash", "https://example.com//"],
  ["double slash in path", "https://example.com/a//b"],
  ["double slash after host", "https://example.com//a"],
  ["percent-encoded dots", "https://example.com/%2e%2e"],
  ["percent-encoded slash", "https://example.com/a%2Fb"],
  ["percent sign", "https://example.com/100%"],
  ["backslash", "https://example.com\\a"],
  ["space in path", "https://example.com/a b"],
  ["control character", "https://example.com/a\nb"],
  ["too long", `https://example.com/${"a".repeat(600)}`],
];

for (const [label, value] of REJECTED) {
  test(`rejects ${label}`, () => {
    assert.throws(
      () => parseSiteUrl(value as string),
      (e: unknown) =>
        e instanceof WordPressError && e.code === "SITE_URL_INVALID",
      label,
    );
  });
}

test("siteHostOf returns the lower-case host of a validated base", () => {
  assert.equal(siteHostOf("https://example.com"), "example.com");
  assert.equal(siteHostOf("https://example.com/blog/news"), "example.com");
  assert.equal(siteHostOf("https://sub.example.co.uk"), "sub.example.co.uk");
});
