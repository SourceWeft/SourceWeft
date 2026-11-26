import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { WordPressError } from "../src/errors";
import { MAX_METADATA_TERMS } from "../src/limits";
import {
  contentHashOf,
  decodeTitle,
  oneLine,
  parseListItem,
  parseMe,
  parsePost,
  parseSearchHit,
  parseTerm,
  parseUser,
  toConnectorItem,
  validateLink,
  type WpListItem,
} from "../src/model";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
}

function first(name: string): unknown {
  const list = fixture(name);
  assert.ok(Array.isArray(list));
  return list[0];
}

function throwsBadResponse(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof WordPressError);
    assert.equal(error.code, "BAD_RESPONSE");
    return true;
  });
}

const SITE_HOST = "site.example";

function listItem(overrides: Partial<WpListItem> = {}): WpListItem {
  return {
    id: 7,
    type: "post",
    status: "publish",
    link: "https://site.example/hello/",
    title: "Hello",
    modifiedGmt: "2026-01-02T03:04:05",
    categoryIds: [10, 11],
    tagIds: [20, 21],
    authorId: 5,
    ...overrides,
  };
}

const names = {
  categories: new Map([
    [10, "News"],
    [11, "Releases"],
  ]),
  tags: new Map([
    [20, "alpha"],
    [21, "beta"],
  ]),
};

// ---------------------------------------------------------------- parsers

test("parseListItem accepts a real wordpress.org post", () => {
  const item = parseListItem(first("wordpress-org-posts.json"));
  assert.deepEqual(item, {
    id: 1,
    type: "post",
    status: "publish",
    link: "https://wordpress.org/news/2003/04/welcome/",
    title: "Welcome",
    modifiedGmt: "2021-06-04T11:57:33",
    categoryIds: [12],
    tagIds: [],
    authorId: 1,
  });
});

test("parseListItem accepts a real page that has no categories or tags", () => {
  const item = parseListItem(first("wordpress-org-pages.json"));
  assert.equal(item.type, "page");
  assert.deepEqual(item.categoryIds, []);
  assert.deepEqual(item.tagIds, []);
  assert.equal(item.authorId, 1819835);
});

test("parseListItem accepts a real WordPress.com post and decodes its title", () => {
  const item = parseListItem(first("wordpress-com-posts.json"));
  assert.equal(
    item.title,
    "How to Build a Small Business Website on WordPress.com",
  );
  assert.deepEqual(item.tagIds, [2436960, 10585, 51945369]);
});

test("parsePost accepts a real full wordpress.org post", () => {
  const post = parsePost(first("wordpress-org-post-full.json"));
  assert.equal(post.id, 22114);
  assert.equal(post.slug, "wordpress-7-2-release-candidate-3");
  assert.equal(post.publishedGmt, "2026-11-24T15:53:15");
  assert.equal(post.protected, false);
  assert.deepEqual(post.categoryIds, [5, 14]);
  assert.deepEqual(post.tagIds, [649, 184, 409]);
  assert.match(post.contentHtml, /<h2 class="wp-block-heading">/);
  assert.equal(post.title, "WordPress 7.2 Release Candidate 3");
});

test("parsePost reads a protected post", () => {
  const raw = first("wordpress-org-post-full.json") as Record<string, unknown>;
  const post = parsePost({
    ...raw,
    content: { rendered: "", protected: true },
  });
  assert.equal(post.protected, true);
  assert.equal(post.contentHtml, "");
});

test("a malformed list item throws BAD_RESPONSE, never a partial object", () => {
  const good = first("wordpress-org-posts.json") as Record<string, unknown>;
  const cases: Record<string, unknown> = {
    "not an object": "post",
    null: null,
    array: [],
    "string id": { ...good, id: "1" },
    "negative id": { ...good, id: -1 },
    "zero id": { ...good, id: 0 },
    "fractional id": { ...good, id: 1.5 },
    "huge id": { ...good, id: 2 ** 60 },
    "categories not an array": { ...good, categories: "12" },
    "category negative": { ...good, categories: [-3] },
    "category fractional": { ...good, categories: [1.5] },
    "tags not an array": { ...good, tags: { a: 1 } },
    "tag a string": { ...good, tags: ["x"] },
    "missing modified_gmt": { ...good, modified_gmt: undefined },
    "modified_gmt not a string": { ...good, modified_gmt: 5 },
    "modified_gmt not a date": { ...good, modified_gmt: "yesterday" },
    "zero modified_gmt": { ...good, modified_gmt: "0000-00-00T00:00:00" },
    "missing type": { ...good, type: undefined },
    "unknown type": { ...good, type: "product" },
    "missing status": { ...good, status: undefined },
    "status with spaces": { ...good, status: "pub lish\n" },
    "title not an object": { ...good, title: "Welcome" },
    "title.rendered not a string": { ...good, title: { rendered: 3 } },
    "missing link": { ...good, link: undefined },
    "empty link": { ...good, link: "" },
    "author a string": { ...good, author: "1" },
    "author negative": { ...good, author: -1 },
  };
  for (const [label, raw] of Object.entries(cases)) {
    assert.throws(
      () => parseListItem(raw),
      (error: unknown) =>
        error instanceof WordPressError && error.code === "BAD_RESPONSE",
      label,
    );
  }
});

test("parseListItem treats author 0 or absent as no author", () => {
  const good = first("wordpress-org-posts.json") as Record<string, unknown>;
  assert.equal(parseListItem({ ...good, author: 0 }).authorId, null);
  assert.equal(parseListItem({ ...good, author: undefined }).authorId, null);
  assert.equal(parseListItem({ ...good, author: null }).authorId, null);
});

test("parsePost rejects a missing or malformed body", () => {
  const good = first("wordpress-org-post-full.json") as Record<string, unknown>;
  throwsBadResponse(() => parsePost({ ...good, content: undefined }));
  throwsBadResponse(() => parsePost({ ...good, content: "x" }));
  throwsBadResponse(() => parsePost({ ...good, content: { rendered: 5 } }));
  throwsBadResponse(() =>
    parsePost({ ...good, content: { protected: false } }),
  );
  throwsBadResponse(() =>
    parsePost({ ...good, content: { rendered: "", protected: "yes" } }),
  );
  throwsBadResponse(() => parsePost({ ...good, slug: 5 }));
  throwsBadResponse(() => parsePost({ ...good, modified_gmt: "x" }));
});

test("parseTerm accepts real categories and tags and decodes the name", () => {
  assert.deepEqual(parseTerm(first("wordpress-org-categories.json")), {
    id: 143,
    name: "Awards",
    parent: 0,
  });
  assert.deepEqual(parseTerm(first("wordpress-org-tags.json")), {
    id: 360,
    name: "#ContributorStory",
    parent: 0,
  });
  assert.equal(
    parseTerm({ id: 4, name: "News &amp; <b>Events</b>", parent: 3 }).name,
    "News & Events",
  );
});

test("parseTerm rejects bad ids, names and parents", () => {
  throwsBadResponse(() => parseTerm({ id: 0, name: "x", parent: 0 }));
  throwsBadResponse(() => parseTerm({ id: 1.5, name: "x", parent: 0 }));
  throwsBadResponse(() => parseTerm({ id: 1, parent: 0 }));
  throwsBadResponse(() => parseTerm({ id: 1, name: 5, parent: 0 }));
  throwsBadResponse(() => parseTerm({ id: 1, name: "x", parent: -1 }));
  throwsBadResponse(() => parseTerm({ id: 1, name: "x", parent: "0" }));
  throwsBadResponse(() => parseTerm(null));
});

test("parseUser and parseMe", () => {
  assert.deepEqual(parseUser(first("wordpress-org-users.json")), {
    id: 140668,
    name: "Aaron D. Campbell",
  });
  throwsBadResponse(() => parseUser({ id: -1, name: "x" }));
  throwsBadResponse(() => parseUser({ id: 1 }));
  assert.deepEqual(
    parseMe({
      id: 9,
      name: "Ann &amp; Co",
      capabilities: { edit_posts: true, read: true, nope: false, junk: "x" },
    }),
    {
      id: 9,
      name: "Ann & Co",
      capabilities: { edit_posts: true, read: true, nope: false },
    },
  );
  throwsBadResponse(() => parseMe({ id: 9, name: "x", capabilities: [] }));
  throwsBadResponse(() => parseMe({ id: 0, name: "x", capabilities: {} }));
  throwsBadResponse(() => parseMe("x"));
});

test("parseSearchHit reads a search result", () => {
  assert.deepEqual(
    parseSearchHit({
      id: 3,
      title: "About &amp; us",
      url: "https://site.example/about/",
      type: "post",
      subtype: "page",
    }),
    {
      id: 3,
      type: "page",
      title: "About & us",
      url: "https://site.example/about/",
    },
  );
  throwsBadResponse(() =>
    parseSearchHit({
      id: 3,
      title: "x",
      url: "u",
      type: "post",
      subtype: "product",
    }),
  );
  throwsBadResponse(() =>
    parseSearchHit({
      id: 0,
      title: "x",
      url: "u",
      type: "post",
      subtype: "post",
    }),
  );
});

// ------------------------------------------------------------------ text

test("decodeTitle removes tags, decodes entities and keeps one line", () => {
  assert.equal(decodeTitle("Plain"), "Plain");
  assert.equal(decodeTitle("A &amp; B"), "A & B");
  assert.equal(decodeTitle("It&#8217;s &#x2014; done"), "It’s — done");
  assert.equal(decodeTitle("<em>Big</em> news<br/>today"), "Big newstoday");
  assert.equal(decodeTitle("a&nbsp;b"), "a b");
  assert.equal(decodeTitle("line1\n\n## Post\n---"), "line1 ## Post ---");
  assert.equal(decodeTitle("a&#10;## b"), "a ## b");
  // Decoded after tag removal: an encoded tag stays text and is not re-parsed.
  assert.equal(
    decodeTitle("&lt;script&gt;x&lt;/script&gt;"),
    "<script>x</script>",
  );
  // Unknown or malformed entities stay as written.
  assert.equal(decodeTitle("&bogus; &#xZZ; &#; &"), "&bogus; &#xZZ; &#; &");
  // Invalid code points do not throw.
  assert.equal(decodeTitle("a&#0;b&#x110000;c&#xD800;d"), "a�b�c�d");
  assert.equal(decodeTitle("tab\there\u0007bell"), "tab here bell");
});

test("decodeTitle is capped and linear on hostile input", () => {
  const started = Date.now();
  const hostile = "<a ".repeat(300_000) + "&amp;".repeat(100_000);
  const out = decodeTitle(hostile);
  assert.ok(out.length <= 1_000);
  assert.ok(Date.now() - started < 2_000, "decodeTitle must be linear");
  assert.ok(decodeTitle("x".repeat(5_000)).length <= 1_000);
});

test("oneLine collapses every kind of whitespace and control character", () => {
  assert.equal(oneLine("  a \n\t b c\u0000d  "), "a b c d");
  assert.equal(oneLine(""), "");
});

// ------------------------------------------------------------------ links

test("validateLink accepts https links on the site host, case-insensitively", () => {
  assert.equal(
    validateLink("https://site.example/a/b/?x=1", SITE_HOST),
    "https://site.example/a/b/?x=1",
  );
  assert.equal(
    validateLink("HTTPS://Site.Example/Path", SITE_HOST),
    "https://site.example/Path",
  );
  assert.equal(
    validateLink("https://site.example", "SITE.example"),
    "https://site.example/",
  );
});

test("validateLink rejects anything else with LINK_HOST_MISMATCH", () => {
  const bad = [
    "https://other.example/a",
    "https://sub.site.example/a",
    "https://site.example.evil.example/a",
    "https://site.example.evil/a",
    "http://site.example/a",
    "//site.example/a",
    "/a/b",
    "a/b",
    "",
    "https://user@site.example/a",
    "https://user:pw@site.example/a",
    "https://site.example:8443/a",
    "javascript:alert(1)",
    "data:text/html,x",
    "ftp://site.example/a",
    "https://site.example@evil.example/a",
    `https://site.example/${"a".repeat(3_000)}`,
  ];
  for (const link of bad) {
    assert.throws(
      () => validateLink(link, SITE_HOST),
      (error: unknown) =>
        error instanceof WordPressError && error.code === "LINK_HOST_MISMATCH",
      link.slice(0, 60),
    );
  }
});

test("validateLink does not keep control characters of the input", () => {
  const out = validateLink("https://site.example/a\nb\tc", SITE_HOST);
  assert.ok(!/[\u0000-\u001f]/.test(out));
});

// ------------------------------------------------------------------- hash

test("contentHashOf is a sha256 hex string and stable", () => {
  const a = contentHashOf(listItem(), names);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, contentHashOf(listItem(), names));
});

test("contentHashOf changes with each hashed field", () => {
  const base = contentHashOf(listItem(), names);
  const changed = [
    contentHashOf(listItem({ modifiedGmt: "2026-01-02T03:04:06" }), names),
    contentHashOf(listItem({ title: "Hello!" }), names),
    contentHashOf(listItem({ status: "private" }), names),
    contentHashOf(listItem({ link: "https://site.example/hello-2/" }), names),
    contentHashOf(listItem({ id: 8 }), names),
    contentHashOf(listItem({ type: "page" }), names),
    contentHashOf(listItem(), {
      categories: new Map([
        [10, "News"],
        [11, "Release notes"],
      ]),
      tags: names.tags,
    }),
    contentHashOf(listItem(), {
      categories: names.categories,
      tags: new Map([
        [20, "alpha"],
        [21, "gamma"],
      ]),
    }),
  ];
  for (const hash of changed) assert.notEqual(hash, base);
  assert.equal(new Set(changed).size, changed.length);
});

test("contentHashOf is independent of the order of categories and tags", () => {
  const a = contentHashOf(
    listItem({ categoryIds: [10, 11], tagIds: [20, 21] }),
    names,
  );
  const b = contentHashOf(
    listItem({ categoryIds: [11, 10], tagIds: [21, 20] }),
    names,
  );
  assert.equal(a, b);
});

test("contentHashOf does not depend on the author, the body or the slug", () => {
  const item = listItem();
  const post = {
    ...item,
    authorId: 99,
    contentHtml: "<p>x</p>",
    protected: false,
    publishedGmt: "2026-01-01T00:00:00",
    slug: "different",
  };
  assert.equal(contentHashOf(post, names), contentHashOf(item, names));
});

test("a list item and the full post of the same item hash alike", () => {
  const raw = first("wordpress-org-post-full.json");
  const post = parsePost(raw);
  const {
    contentHtml,
    protected: isProtected,
    publishedGmt,
    slug,
    ...rest
  } = post;
  void contentHtml;
  void isProtected;
  void publishedGmt;
  void slug;
  const n = {
    categories: new Map([
      [5, "Releases"],
      [14, "Development"],
    ]),
    tags: new Map([
      [649, "rc"],
      [184, "release"],
      [409, "7.2"],
    ]),
  };
  assert.equal(contentHashOf(post, n), contentHashOf(rest, n));
});

test("contentHashOf cannot be forged by moving text between fields", () => {
  const a = contentHashOf(listItem({ title: "a", status: "bc" }), names);
  const b = contentHashOf(listItem({ title: "ab", status: "c" }), names);
  assert.notEqual(a, b);
  const c = contentHashOf(listItem({ categoryIds: [10] }), {
    categories: new Map([[10, "a\u0001b"]]),
    tags: new Map(),
  });
  const d = contentHashOf(listItem({ categoryIds: [10, 11] }), {
    categories: new Map([
      [10, "a"],
      [11, "b"],
    ]),
    tags: new Map(),
  });
  assert.notEqual(c, d);
});

// ------------------------------------------------------------ connector item

test("toConnectorItem fills every field", () => {
  const item = toConnectorItem(listItem(), names, "Ann", SITE_HOST);
  assert.equal(item.externalId, "wordpress:post:7");
  assert.equal(item.externalUri, "https://site.example/hello/");
  assert.equal(item.title, "Hello");
  assert.equal(item.mimeType, "text/markdown");
  assert.equal(item.sizeBytes, null);
  assert.equal(
    item.externalUpdatedAt?.toISOString(),
    "2026-01-02T03:04:05.000Z",
  );
  assert.equal(item.contentHash, contentHashOf(listItem(), names));
  assert.deepEqual(item.metadata, {
    siteHost: "site.example",
    wpId: 7,
    wpType: "post",
    status: "publish",
    categories: [
      { id: 10, name: "News" },
      { id: 11, name: "Releases" },
    ],
    tags: ["alpha", "beta"],
    authorId: 5,
    authorName: "Ann",
    modifiedAt: "2026-01-02T03:04:05.000Z",
  });
});

test("toConnectorItem for a page, a full post and no author", () => {
  const page = toConnectorItem(
    listItem({ type: "page", categoryIds: [], tagIds: [], authorId: null }),
    names,
    null,
    SITE_HOST,
  );
  assert.equal(page.externalId, "wordpress:page:7");
  assert.equal(page.metadata.wpType, "page");
  assert.ok(!("authorId" in page.metadata));
  assert.ok(!("authorName" in page.metadata));
  assert.ok(!("categories" in page.metadata));
  assert.ok(!("tags" in page.metadata));

  const full = toConnectorItem(
    {
      ...listItem(),
      contentHtml: "<p>x</p>",
      protected: false,
      publishedGmt: "2026-01-01T00:00:00",
      slug: "hello",
    },
    names,
    "Ann",
    SITE_HOST,
  );
  assert.equal(full.metadata.slug, "hello");
  assert.equal(full.metadata.publishedAt, "2026-01-01T00:00:00.000Z");
});

test("toConnectorItem metadata is one-line, and the title falls back when empty", () => {
  const item = toConnectorItem(
    listItem({ title: "" }),
    {
      categories: new Map([[10, "A\nB"]]),
      tags: new Map([[20, "x\ny"]]),
    },
    "An\nn",
    SITE_HOST,
  );
  assert.equal(item.title, "Untitled");
  assert.deepEqual(item.metadata.categories, [{ id: 10, name: "A B" }]);
  assert.deepEqual(item.metadata.tags, ["x y"]);
  assert.equal(item.metadata.authorName, "An n");
});

test("toConnectorItem caps categories and tags at MAX_METADATA_TERMS", () => {
  const ids = Array.from({ length: 80 }, (_, i) => i + 1);
  const map = new Map(ids.map((id) => [id, `name ${id}`]));
  const item = toConnectorItem(
    listItem({ categoryIds: ids, tagIds: ids }),
    { categories: map, tags: map },
    null,
    SITE_HOST,
  );
  assert.equal(
    (item.metadata.categories as unknown[]).length,
    MAX_METADATA_TERMS,
  );
  assert.equal((item.metadata.tags as unknown[]).length, MAX_METADATA_TERMS);
  assert.equal(MAX_METADATA_TERMS, 50);
});

test("toConnectorItem rejects a link on another host", () => {
  assert.throws(
    () =>
      toConnectorItem(
        listItem({ link: "https://other.example/x/" }),
        names,
        null,
        SITE_HOST,
      ),
    (error: unknown) =>
      error instanceof WordPressError && error.code === "LINK_HOST_MISMATCH",
  );
});
