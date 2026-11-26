import assert from "node:assert/strict";
import test from "node:test";
import { DiscourseError } from "../src/errors";
import { parseForumUrl, postUrl, topicUrl } from "../src/forum-url";

test("accepts a plain forum host", () => {
  assert.deepEqual(parseForumUrl("https://forum.example.com"), {
    origin: "https://forum.example.com",
    base: "https://forum.example.com",
  });
});

test("trims one trailing slash and lowercases only the host", () => {
  assert.deepEqual(parseForumUrl("https://Forum.Example.COM/"), {
    origin: "https://forum.example.com",
    base: "https://forum.example.com",
  });
  assert.deepEqual(
    parseForumUrl("https://Forum.Example.COM/Community/Forum/"),
    {
      origin: "https://forum.example.com",
      base: "https://forum.example.com/Community/Forum",
    },
  );
});

test("accepts a punycode host and a dotted subfolder name", () => {
  assert.equal(
    parseForumUrl("https://xn--e1afmkfd.xn--p1ai")?.base,
    "https://xn--e1afmkfd.xn--p1ai",
  );
  assert.equal(
    parseForumUrl("https://x.example.org/v1.2/forum_a~b")?.base,
    "https://x.example.org/v1.2/forum_a~b",
  );
});

test("the 512-character limit is inclusive", () => {
  const host = "https://forum.example.com/";
  const ok = host + "a".repeat(512 - host.length);
  assert.equal(ok.length, 512);
  assert.notEqual(parseForumUrl(ok), null);
  assert.equal(parseForumUrl(`${ok}a`), null);
});

const REJECTED: [string, unknown][] = [
  ["not a string: null", null],
  ["not a string: number", 5],
  ["not a string: object", {}],
  ["empty", ""],
  ["http", "http://forum.example.com"],
  ["other scheme", "ftp://forum.example.com"],
  ["no scheme", "forum.example.com"],
  ["uppercase scheme", "HTTPS://forum.example.com"],
  ["leading whitespace", " https://forum.example.com"],
  ["trailing whitespace", "https://forum.example.com "],
  ["IPv4", "https://127.0.0.1"],
  ["IPv4 with path", "https://192.168.1.1/forum"],
  ["public IPv4", "https://8.8.8.8"],
  ["decimal host", "https://2130706433"],
  ["hex host", "https://0x7f000001"],
  ["dotted hex host", "https://0x7f.0x0.0x0.0x1"],
  ["octal-ish host", "https://0177.0.0.1"],
  ["bracketed IPv6", "https://[::1]"],
  ["bracketed IPv6 with path", "https://[2001:db8::1]/forum"],
  ["localhost", "https://localhost"],
  ["localhost uppercase", "https://LOCALHOST"],
  ["localhost subdomain", "https://forum.localhost"],
  ["local suffix", "https://forum.local"],
  ["internal suffix", "https://forum.internal"],
  ["single label", "https://intranet"],
  ["empty label", "https://forum..example.com"],
  ["leading dot", "https://.example.com"],
  ["trailing dot", "https://example.com."],
  ["leading hyphen label", "https://-a.example.com"],
  ["trailing hyphen label", "https://a-.example.com"],
  ["underscore host", "https://a_b.example.com"],
  ["non-ascii host", "https://münchen.example.com"],
  ["label over 63", `https://${"a".repeat(64)}.example.com`],
  ["host over 253", `https://${"a.".repeat(130)}com`],
  ["port", "https://forum.example.com:8443"],
  ["port with path", "https://forum.example.com:443/forum"],
  ["userinfo", "https://user:pass@forum.example.com"],
  ["user only", "https://user@forum.example.com"],
  ["query", "https://forum.example.com/?a=1"],
  ["empty query", "https://forum.example.com/forum?"],
  ["fragment", "https://forum.example.com/#top"],
  ["empty fragment", "https://forum.example.com/forum#"],
  ["dot segment", "https://forum.example.com/."],
  ["dot-dot segment", "https://forum.example.com/.."],
  ["dot-dot in the middle", "https://forum.example.com/a/../b"],
  ["dot in the middle", "https://forum.example.com/a/./b"],
  ["double slash", "https://forum.example.com//"],
  ["double slash in path", "https://forum.example.com/a//b"],
  ["double slash after host", "https://forum.example.com//a"],
  ["percent-encoded dots", "https://forum.example.com/%2e%2e"],
  ["percent-encoded slash", "https://forum.example.com/a%2Fb"],
  ["percent sign", "https://forum.example.com/100%"],
  ["backslash", "https://forum.example.com\\a"],
  ["space in path", "https://forum.example.com/a b"],
  ["control character", "https://forum.example.com/a\nb"],
  ["too long", `https://forum.example.com/${"a".repeat(600)}`],
];

for (const [name, value] of REJECTED) {
  test(`rejects ${name}`, () => {
    assert.equal(parseForumUrl(value), null);
  });
}

test("topicUrl and postUrl build links under the base", () => {
  const base = "https://forum.example.com/forum";
  assert.equal(topicUrl(base, "my-topic", 12), `${base}/t/my-topic/12`);
  assert.equal(postUrl(base, "my-topic", 12, 3), `${base}/t/my-topic/12/3`);
  assert.equal(
    topicUrl("https://forum.example.com", "x", 1),
    "https://forum.example.com/t/x/1",
  );
});

test("slugs are sanitised and never echoed hostile", () => {
  const base = "https://forum.example.com";
  const shape = /^https:\/\/forum\.example\.com\/t\/[a-z0-9-]+\/12$/;
  for (const slug of [
    "../../etc/passwd",
    "<script>alert(1)</script>",
    "a b/c?d#e",
    "%2e%2e",
    "https://evil.example/x",
    "UPPER-Case",
    "ünïcode",
    "",
    "   ",
    "///",
    "a".repeat(5000),
  ]) {
    const url = topicUrl(base, slug, 12);
    assert.match(url, shape, `slug ${JSON.stringify(slug).slice(0, 40)}`);
    assert.ok(url.length < 200);
  }
  assert.equal(topicUrl(base, "UPPER-Case", 12), `${base}/t/upper-case/12`);
  assert.equal(topicUrl(base, "", 12), `${base}/t/topic/12`);
  assert.equal(topicUrl(base, "ünïcode", 12), `${base}/t/topic/12`);
  assert.equal(
    topicUrl(base, 5 as unknown as string, 12),
    `${base}/t/topic/12`,
  );
});

test("link builders refuse an invalid base or id", () => {
  const bad = (fn: () => unknown) =>
    assert.throws(fn, (e: unknown) => {
      assert.ok(e instanceof DiscourseError);
      assert.equal(e.code, "DISCOURSE_CONFIG_INVALID");
      return true;
    });
  bad(() => topicUrl("http://forum.example.com", "x", 1));
  bad(() => topicUrl("https://forum.example.com/", "x", 1));
  bad(() => topicUrl("https://forum.example.com", "x", 0));
  bad(() => topicUrl("https://forum.example.com", "x", 1.5));
  bad(() => topicUrl("https://forum.example.com", "x", Number.NaN));
  bad(() => postUrl("https://forum.example.com", "x", 1, 0));
  bad(() => postUrl("https://forum.example.com", "x", 1, -2));
});
