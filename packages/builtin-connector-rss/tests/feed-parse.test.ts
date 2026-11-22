import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FEED_MAX_ITEMS } from "../src/limits";
import { FeedParseError, parseFeed } from "../src/feed-parse";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function assertNotAFeed(xml: string): void {
  assert.throws(
    () => parseFeed(xml),
    (error: unknown) =>
      error instanceof FeedParseError && error.reason === "feed_not_a_feed",
  );
}

test("RSS 2.0 yields titles, authors, dates, links and reduced text", () => {
  const feed = parseFeed(fixture("rss2.xml"));
  assert.equal(feed.title, "Example Feed");
  assert.equal(feed.truncated, false);
  assert.equal(feed.items.length, 2);

  const [first, second] = feed.items;
  assert.deepEqual(first, {
    externalId: "post-1",
    title: "First & foremost",
    link: "https://example.com/posts/1?utm_source=feed&id=1#top",
    author: "Ada Lovelace",
    publishedAt: new Date("2025-11-03T10:00:00Z"),
    updatedAt: null,
    text: "Full body text\n\nSecond paragraph",
  });
  assert.equal(second?.externalId, "https://example.com/posts/2");
  assert.equal(second?.author, "bob@example.com (Bob)");
  assert.deepEqual(second?.publishedAt, new Date("2025-11-04T12:30:00Z"));
  assert.equal(second?.text, "Escaped html description");
});

test("Atom prefers rel=alternate and reads author.name, dates and content", () => {
  const feed = parseFeed(fixture("atom.xml"));
  assert.equal(feed.title, "Atom Example");
  assert.equal(feed.items.length, 2);

  const [first, second] = feed.items;
  assert.deepEqual(first, {
    externalId: "urn:uuid:entry-1",
    title: "Atom <one>",
    link: "https://example.com/atom/1",
    author: "Grace Hopper",
    publishedAt: new Date("2025-11-01T08:00:00Z"),
    updatedAt: new Date("2025-11-02T08:30:00Z"),
    text: "Atom content",
  });
  assert.equal(second?.link, "https://example.com/atom/2");
  assert.equal(second?.author, "Feed Author");
  assert.equal(second?.publishedAt, null);
  assert.deepEqual(second?.updatedAt, new Date("2025-11-02T22:00:00Z"));
  assert.equal(second?.text, "Plain summary two");
});

test("without a guid the identity is the canonical link, then a stable hash", () => {
  const xml = fixture("rss2-no-guid.xml");
  const feed = parseFeed(xml);
  assert.equal(feed.items.length, 2);
  assert.equal(feed.items[0]?.externalId, "https://example.com/a?k=v");
  assert.equal(
    feed.items[1]?.externalId,
    `h:${sha256("No link either|2025-11-03T11:00:00.000Z")}`,
  );
  assert.deepEqual(
    parseFeed(xml).items.map((item) => item.externalId),
    feed.items.map((item) => item.externalId),
  );
});

test("duplicate identities within a feed keep the first item", () => {
  const feed = parseFeed(fixture("rss2-duplicate-guid.xml"));
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0]?.title, "Original");
  assert.equal(feed.items[0]?.externalId, "same-guid");
});

function manyItems(count: number): string {
  const items = Array.from(
    { length: count },
    (_, i) =>
      `<item><title>t${i}</title><guid>g${i}</guid><description>d${i}</description></item>`,
  ).join("");
  return `<rss version="2.0"><channel><title>Big</title>${items}</channel></rss>`;
}

test("more than the item cap keeps the first 500 in order and flags truncation", () => {
  const feed = parseFeed(manyItems(600));
  assert.equal(feed.items.length, FEED_MAX_ITEMS);
  assert.equal(FEED_MAX_ITEMS, 500);
  assert.equal(feed.truncated, true);
  assert.equal(feed.items[0]?.externalId, "g0");
  assert.equal(feed.items[499]?.externalId, "g499");
});

test("maxItems overrides the default and an exact fit is not truncated", () => {
  const small = parseFeed(manyItems(5), { maxItems: 3 });
  assert.deepEqual(
    small.items.map((item) => item.externalId),
    ["g0", "g1", "g2"],
  );
  assert.equal(small.truncated, true);
  const exact = parseFeed(manyItems(3), { maxItems: 3 });
  assert.equal(exact.items.length, 3);
  assert.equal(exact.truncated, false);
});

test("a DOCTYPE entity bomb is rejected quickly as not a feed", () => {
  const started = Date.now();
  assertNotAFeed(fixture("entity-bomb.xml"));
  assert.ok(Date.now() - started < 200, `took ${Date.now() - started} ms`);
});

test("any <!ENTITY declaration is rejected, external ones included", () => {
  assertNotAFeed(
    `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]>` +
      `<rss version="2.0"><channel><title>&x;</title></channel></rss>`,
  );
});

test("a benign 5 MiB feed with 50 000 &amp; references still parses", () => {
  const filler = "lorem ipsum dolor sit amet ".repeat(200_000);
  const body = `${"a &amp; b ".repeat(50_000)}${filler}`.slice(
    0,
    5 * 1024 * 1024 - 400,
  );
  const xml =
    `<rss version="2.0"><channel><title>Big &amp; benign</title>` +
    `<item><title>x</title><guid>one</guid><description>${body}</description></item>` +
    `</channel></rss>`;
  assert.ok(xml.length > 4.9 * 1024 * 1024);
  assert.ok((xml.match(/&amp;/g) ?? []).length >= 50_000);
  const feed = parseFeed(xml);
  assert.equal(feed.title, "Big & benign");
  assert.equal(feed.items.length, 1);
  assert.ok(feed.items[0]!.text.startsWith("a & b a & b"));
});

test("RSS 1.0/RDF, an HTML page and malformed XML are not feeds", () => {
  assertNotAFeed(fixture("rdf.xml"));
  assertNotAFeed(fixture("html-page.html"));
  assertNotAFeed(fixture("malformed.xml"));
  assertNotAFeed("");
  assertNotAFeed("plain text, not xml");
  assertNotAFeed(
    `<rss version="0.91"><channel><title>old</title></channel></rss>`,
  );
  assertNotAFeed(`<rss version="2.0"></rss>`);
});

test("FeedParseError carries a fixed reason and leaks no document content", () => {
  try {
    parseFeed("<secret-token-abc>");
    assert.fail("expected a throw");
  } catch (error) {
    assert.ok(error instanceof FeedParseError);
    assert.equal(error.reason, "feed_not_a_feed");
    assert.ok(!error.message.includes("secret-token-abc"));
  }
});

test("a leading BOM and whitespace before the XML declaration are tolerated", () => {
  const feed = parseFeed(`﻿\n  ${fixture("rss2.xml")}`);
  assert.equal(feed.items.length, 2);
});

test("numeric-looking guids and titles stay strings", () => {
  const feed = parseFeed(
    `<rss version="2.0"><channel><title>007</title>` +
      `<item><title>12345</title><guid>0042</guid></item></channel></rss>`,
  );
  assert.equal(feed.title, "007");
  assert.equal(feed.items[0]?.title, "12345");
  assert.equal(feed.items[0]?.externalId, "0042");
});

test("a non-http link is dropped rather than carried through", () => {
  const feed = parseFeed(
    `<rss version="2.0"><channel><title>x</title>` +
      `<item><title>a</title><link>javascript:alert(1)</link></item></channel></rss>`,
  );
  assert.equal(feed.items[0]?.link, null);
});

// Hostile shapes: bounded in time whether they parse or are rejected.
function timed(xml: string): number {
  const started = Date.now();
  try {
    parseFeed(xml);
  } catch (error) {
    assert.ok(
      error instanceof FeedParseError && error.reason === "feed_not_a_feed",
    );
  }
  return Date.now() - started;
}

const deepXml = (depth: number): string =>
  `<rss version="2.0"><channel><title>t</title>${"<a>".repeat(depth)}x${"</a>".repeat(depth)}</channel></rss>`;
const attrsXml = (count: number): string =>
  `<rss version="2.0"><channel><title>t</title><item ${Array.from({ length: count }, (_, i) => `a${i}="v"`).join(" ")}><title>x</title></item></channel></rss>`;

test("100k levels of nesting are rejected or parsed in under 2 s", () => {
  const elapsed = timed(deepXml(100_000));
  assert.ok(elapsed < 2_000, `took ${elapsed} ms`);
  assertNotAFeed(deepXml(100_000));
});

test("an element with 60k unique attributes is bounded in time", () => {
  const elapsed = timed(attrsXml(60_000));
  assert.ok(elapsed < 2_000, `took ${elapsed} ms`);
});

test("a ~5 MiB mix of deep nesting and attribute-heavy tags is bounded in time", () => {
  // 90 levels stay under the nesting cap, so the whole document is parsed.
  const deep = `${"<a>".repeat(90)}${"</a>".repeat(90)}`;
  const wide = `<i ${Array.from({ length: 500 }, (_, i) => `a${i}="v"`).join(" ")}>x</i>`;
  const unit = `${deep}${wide}`;
  const xml = `<rss version="2.0"><channel><title>t</title>${unit.repeat(
    Math.ceil((5 * 1024 * 1024) / unit.length),
  )}</channel></rss>`;
  assert.ok(xml.length >= 5 * 1024 * 1024);
  const elapsed = timed(xml);
  assert.ok(elapsed < 2_000, `took ${elapsed} ms`);
});
