import assert from "node:assert/strict";
import test from "node:test";
import { parseFeedUrl, redactFeedUrl } from "../src/feed-url";
import { RSS_FEED_URL_PATTERN } from "../src";

test("http is rejected as feed_https_required", () => {
  assert.deepEqual(parseFeedUrl("http://x/feed"), {
    ok: false,
    reason: "feed_https_required",
  });
});

test("userinfo is rejected as feed_credentials_not_allowed", () => {
  assert.deepEqual(parseFeedUrl("https://u:p@x/feed"), {
    ok: false,
    reason: "feed_credentials_not_allowed",
  });
  assert.deepEqual(parseFeedUrl("https://u@x/feed"), {
    ok: false,
    reason: "feed_credentials_not_allowed",
  });
});

test("non-URLs and other schemes are feed_url_invalid or https-required", () => {
  assert.deepEqual(parseFeedUrl("not a url"), {
    ok: false,
    reason: "feed_url_invalid",
  });
  assert.deepEqual(parseFeedUrl(""), { ok: false, reason: "feed_url_invalid" });
  assert.equal(parseFeedUrl("ftp://x/feed").ok, false);
});

test("a token query is accepted and the redacted form carries no token and no query", () => {
  const raw = "https://x/feed?token=SECRET-TOKEN-123";
  const parsed = parseFeedUrl(raw);
  assert.equal(parsed.ok, true);
  const redacted = redactFeedUrl(raw);
  assert.equal(redacted, "https://x/feed");
  assert.ok(!redacted.includes("SECRET-TOKEN-123"));
  assert.ok(!redacted.includes("?"));
});

test("the value is trimmed and the host lowercased", () => {
  const parsed = parseFeedUrl("  https://Example.COM/Feed.xml  ");
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.equal(parsed.url.host, "example.com");
    assert.equal(parsed.url.pathname, "/Feed.xml");
  }
});

test("a URL longer than 2048 characters is invalid; exactly 2048 is accepted", () => {
  const prefix = "https://x/";
  const tooLong = prefix + "a".repeat(2049 - prefix.length);
  assert.equal(tooLong.length, 2049);
  assert.deepEqual(parseFeedUrl(tooLong), {
    ok: false,
    reason: "feed_url_invalid",
  });
  const atLimit = prefix + "a".repeat(2048 - prefix.length);
  assert.equal(atLimit.length, 2048);
  assert.equal(parseFeedUrl(atLimit).ok, true);
});

test("redactFeedUrl returns an empty string for an unparseable value", () => {
  assert.equal(redactFeedUrl("not a url"), "");
});

// The manifest's configSchema carries this pattern as the server-side guard.
test("RSS_FEED_URL_PATTERN accepts and rejects the documented shapes", () => {
  const pattern = new RegExp(RSS_FEED_URL_PATTERN);
  const accepted = [
    "https://example.com/feed.xml",
    "https://example.com/feed?token=abc",
  ];
  const rejected = [
    "http://example.com/feed",
    "https://user:pw@example.com/feed",
    "https://exa mple.com/feed",
    `https://example.com/${"a".repeat(2041)}`,
    "",
  ];
  for (const value of accepted) {
    assert.equal(pattern.test(value), true, `should accept ${value}`);
  }
  for (const value of rejected) {
    assert.equal(
      pattern.test(value),
      false,
      `should reject ${value.slice(0, 60)}`,
    );
  }
});
