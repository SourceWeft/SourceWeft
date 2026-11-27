import assert from "node:assert/strict";
import test from "node:test";
import { GhostError } from "../src/errors";
import { MAX_METADATA_TERMS } from "../src/limits";
import {
  contentHashOf,
  oneLine,
  parseItem,
  parseListItem,
  parsePagination,
  parseTag,
  toConnectorItem,
  type GhostItem,
  type GhostListItem,
} from "../src/model";

const ID = "5ddc9141c35e7700383b2937";
const TAG_ID = "59799bbd6ebb2f00243a33db";

/** Shapes recorded from demo.ghost.io (Ghost 6, API v5), trimmed. */
const publicPost = {
  id: ID,
  slug: "welcome",
  url: "https://demo.ghost.io/welcome/",
  title: "Welcome",
  updated_at: "2025-08-12T11:47:21.000+00:00",
  published_at: "2013-08-31T21:24:00.000+00:00",
  visibility: "public",
  access: true,
  canonical_url: "https://example.org/original/",
  tags: [
    {
      id: TAG_ID,
      name: "Getting Started",
      slug: "getting-started",
      description: null,
      visibility: "public",
      url: "https://demo.ghost.io/tag/getting-started/",
    },
  ],
};

const paidPost = {
  id: "6000000000000000000000aa",
  slug: "paid",
  url: "https://demo.ghost.io/paid/",
  title: "Paid",
  updated_at: "2025-08-12T11:47:21.000Z",
  published_at: "2025-08-01T00:00:00.000Z",
  visibility: "paid",
  access: false,
  tags: [],
};

const page = {
  id: "6000000000000000000000bb",
  slug: "about",
  url: "https://demo.ghost.io/about/",
  title: "About",
  updated_at: "2024-01-01T00:00:00.000Z",
  published_at: null,
  visibility: "public",
  access: true,
  canonical_url: null,
  tags: [],
};

function listItem(overrides: Partial<GhostListItem> = {}): GhostListItem {
  return {
    ...parseListItem(publicPost, "post"),
    ...overrides,
  };
}

function throwsBadResponse(fn: () => unknown, label: string): void {
  assert.throws(
    fn,
    (error: unknown) =>
      error instanceof GhostError && error.code === "BAD_RESPONSE",
    label,
  );
}

test("parseListItem accepts a public post recorded from the demo site", () => {
  const item = parseListItem(publicPost, "post");
  assert.deepEqual(item, {
    id: ID,
    type: "post",
    slug: "welcome",
    url: "https://demo.ghost.io/welcome/",
    title: "Welcome",
    updatedAt: "2025-08-12T11:47:21.000+00:00",
    publishedAt: "2013-08-31T21:24:00.000+00:00",
    visibility: "public",
    access: true,
    canonicalUrl: "https://example.org/original/",
    tags: [{ id: TAG_ID, slug: "getting-started", name: "Getting Started" }],
  });
});

test("parseListItem accepts a page, a paid post and a post without canonical_url", () => {
  const p = parseListItem(page, "page");
  assert.equal(p.type, "page");
  assert.equal(p.publishedAt, null);
  assert.equal(p.canonicalUrl, null);

  const paid = parseListItem(paidPost, "post");
  assert.equal(paid.access, false);
  assert.equal(paid.visibility, "paid");
  assert.equal(paid.canonicalUrl, null);
  assert.deepEqual(paid.tags, []);
});

test("parseListItem rejects wrong shapes and never returns a partial object", () => {
  const cases: Array<[string, unknown]> = [
    ["not an object", "x"],
    ["null", null],
    ["an array", []],
    ["id not a string", { ...publicPost, id: 5 }],
    ["id not 24 hex", { ...publicPost, id: "123" }],
    ["id upper case hex", { ...publicPost, id: ID.toUpperCase() }],
    ["id too long", { ...publicPost, id: `${ID}0` }],
    ["missing updated_at", { ...publicPost, updated_at: undefined }],
    ["updated_at not a date", { ...publicPost, updated_at: "yesterday" }],
    ["updated_at a number", { ...publicPost, updated_at: 1 }],
    ["published_at not a date", { ...publicPost, published_at: "soon" }],
    ["missing url", { ...publicPost, url: undefined }],
    ["url not a string", { ...publicPost, url: 5 }],
    ["missing title", { ...publicPost, title: undefined }],
    ["title a number", { ...publicPost, title: 5 }],
    ["missing slug", { ...publicPost, slug: undefined }],
    ["empty slug", { ...publicPost, slug: "" }],
    ["missing visibility", { ...publicPost, visibility: undefined }],
    ["access not a boolean", { ...publicPost, access: "true" }],
    ["missing access", { ...publicPost, access: undefined }],
    ["canonical_url a number", { ...publicPost, canonical_url: 4 }],
    ["tags not an array", { ...publicPost, tags: "a" }],
    ["tags an object", { ...publicPost, tags: {} }],
    ["tags missing", { ...publicPost, tags: undefined }],
    ["a tag that is not an object", { ...publicPost, tags: ["a"] }],
    [
      "a tag without a name",
      { ...publicPost, tags: [{ id: TAG_ID, slug: "a" }] },
    ],
    [
      "a tag with a bad id",
      { ...publicPost, tags: [{ id: "x", slug: "a", name: "A" }] },
    ],
  ];
  for (const [label, raw] of cases) {
    throwsBadResponse(() => parseListItem(raw, "post"), label);
  }
});

test("parseListItem makes titles, slugs and tag names one line", () => {
  const item = parseListItem(
    {
      ...publicPost,
      title: "  Line one\n## Post\n---  ",
      tags: [{ id: TAG_ID, slug: "a", name: "x\n\n[y](http://evil)" }],
    },
    "post",
  );
  assert.equal(item.title, "Line one ## Post ---");
  assert.equal(item.tags[0]!.name, "x [y](http://evil)");
});

test("parseItem adds the html and the author names", () => {
  const item = parseItem(
    {
      ...publicPost,
      html: "<p>Hello</p>",
      authors: [
        { id: "a".repeat(24), name: "  Ada\nLovelace ", slug: "ada" },
        { id: "b".repeat(24), name: "Grace", slug: "grace" },
      ],
    },
    "post",
  );
  assert.equal(item.html, "<p>Hello</p>");
  assert.deepEqual(item.authors, ["Ada Lovelace", "Grace"]);
  assert.equal(item.id, ID);
});

test("parseItem rejects a missing html, non-array authors and a bad author", () => {
  const base = { ...publicPost, html: "<p>x</p>", authors: [] };
  assert.deepEqual(parseItem(base, "post").authors, []);
  throwsBadResponse(
    () => parseItem({ ...base, html: undefined }, "post"),
    "no html",
  );
  throwsBadResponse(() => parseItem({ ...base, html: 5 }, "post"), "html num");
  throwsBadResponse(
    () => parseItem({ ...base, authors: "Ada" }, "post"),
    "authors string",
  );
  throwsBadResponse(
    () => parseItem({ ...base, authors: undefined }, "post"),
    "authors missing",
  );
  throwsBadResponse(
    () => parseItem({ ...base, authors: [{ id: "a".repeat(24) }] }, "post"),
    "author without name",
  );
  throwsBadResponse(() => parseItem({ ...base, id: "x" }, "post"), "bad id");
});

test("parseTag and parsePagination", () => {
  assert.deepEqual(parseTag({ id: TAG_ID, slug: "news", name: " News " }), {
    id: TAG_ID,
    slug: "news",
    name: "News",
  });
  throwsBadResponse(() => parseTag({ id: "z", slug: "a", name: "A" }), "id");
  throwsBadResponse(() => parseTag({ id: TAG_ID, name: "A" }), "slug");
  throwsBadResponse(() => parseTag(null), "null");

  assert.deepEqual(
    parsePagination({
      meta: {
        pagination: {
          page: 2,
          limit: 100,
          pages: 3,
          total: 250,
          next: 3,
          prev: 1,
        },
      },
    }),
    { page: 2, pages: 3, total: 250 },
  );
  for (const raw of [
    null,
    {},
    { meta: {} },
    { meta: { pagination: { page: 1, pages: 1 } } },
    { meta: { pagination: { page: "1", pages: 1, total: 0 } } },
    { meta: { pagination: { page: 1, pages: -1, total: 0 } } },
    { meta: { pagination: { page: 0, pages: 1, total: 0 } } },
    { meta: { pagination: { page: 1, pages: 1.5, total: 0 } } },
  ]) {
    throwsBadResponse(() => parsePagination(raw), JSON.stringify(raw));
  }
});

test("oneLine collapses whitespace and control characters", () => {
  assert.equal(oneLine("  a\n\nb\tc\u0000d\u007fe  "), "a b c d e");
  assert.equal(oneLine("\n"), "");
});

test("the hash changes with updated time, title, url, visibility, a tag slug and a tag name", () => {
  const base = contentHashOf(listItem());
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(contentHashOf(listItem()), base);
  const changed: Array<[string, Partial<GhostListItem>]> = [
    ["updatedAt", { updatedAt: "2025-09-01T00:00:00.000Z" }],
    ["title", { title: "Other" }],
    ["url", { url: "https://demo.ghost.io/other/" }],
    ["visibility", { visibility: "members" }],
    [
      "tag slug",
      { tags: [{ id: TAG_ID, slug: "renamed", name: "Getting Started" }] },
    ],
    [
      "tag name",
      { tags: [{ id: TAG_ID, slug: "getting-started", name: "Begin" }] },
    ],
    ["type", { type: "page" }],
    ["id", { id: "6000000000000000000000cc" }],
  ];
  for (const [label, patch] of changed) {
    assert.notEqual(contentHashOf(listItem(patch)), base, label);
  }
});

test("the hash ignores tag order and the author names", () => {
  const a = { id: "1".repeat(24), slug: "a", name: "A" };
  const b = { id: "2".repeat(24), slug: "b", name: "B" };
  assert.equal(
    contentHashOf(listItem({ tags: [a, b] })),
    contentHashOf(listItem({ tags: [b, a] })),
  );
  const full = (authors: string[]): GhostItem => ({
    ...listItem(),
    html: "<p>x</p>",
    authors,
  });
  assert.equal(
    contentHashOf(full(["Ada"])),
    contentHashOf(full(["Someone else"])),
  );
  // A list item and the same item read singly hash alike.
  assert.equal(contentHashOf(full(["Ada"])), contentHashOf(listItem()));
});

test("toConnectorItem fills the item from the post", () => {
  const item = toConnectorItem(listItem(), "Demo.Ghost.io");
  assert.equal(item.externalId, `ghost:post:${ID}`);
  assert.equal(item.externalUri, "https://demo.ghost.io/welcome/");
  assert.equal(item.title, "Welcome");
  assert.equal(item.mimeType, "text/markdown");
  assert.equal(item.sizeBytes, null);
  assert.deepEqual(
    item.externalUpdatedAt,
    new Date("2025-08-12T11:47:21.000+00:00"),
  );
  assert.equal(item.contentHash, contentHashOf(listItem()));
  assert.deepEqual(item.metadata, {
    siteHost: "demo.ghost.io",
    ghostId: ID,
    ghostType: "post",
    slug: "welcome",
    visibility: "public",
    tags: [{ slug: "getting-started", name: "Getting Started" }],
    publishedAt: "2013-08-31T21:24:00.000Z",
    updatedAt: "2025-08-12T11:47:21.000Z",
    canonicalUrl: "https://example.org/original/",
  });
});

test("toConnectorItem of a full item records the authors; absent values are left out", () => {
  const full: GhostItem = {
    ...parseListItem(page, "page"),
    html: "<p>x</p>",
    authors: ["Ada", "Grace"],
  };
  const item = toConnectorItem(full, "demo.ghost.io");
  assert.equal(item.externalId, `ghost:page:${page.id}`);
  assert.deepEqual(item.metadata.authors, ["Ada", "Grace"]);
  assert.ok(!("publishedAt" in item.metadata));
  assert.ok(!("canonicalUrl" in item.metadata));
  assert.ok(!("tags" in item.metadata));
  const listed = toConnectorItem(parseListItem(page, "page"), "demo.ghost.io");
  assert.ok(!("authors" in listed.metadata));
});

test("toConnectorItem caps tags and authors at the metadata limit", () => {
  const tags = Array.from({ length: MAX_METADATA_TERMS + 20 }, (_, i) => ({
    id: i.toString(16).padStart(24, "0"),
    slug: `t${i}`,
    name: `T${i}`,
  }));
  const authors = Array.from(
    { length: MAX_METADATA_TERMS + 5 },
    (_, i) => `A${i}`,
  );
  const item = toConnectorItem(
    { ...listItem({ tags }), html: "", authors },
    "demo.ghost.io",
  );
  assert.equal((item.metadata.tags as unknown[]).length, MAX_METADATA_TERMS);
  assert.equal((item.metadata.authors as unknown[]).length, MAX_METADATA_TERMS);
});

test("an empty title falls back to Untitled", () => {
  assert.equal(
    toConnectorItem(listItem({ title: "" }), "x.example").title,
    "Untitled",
  );
});

test("a hostile url is LINK_INVALID", () => {
  const hostile = [
    "http://demo.ghost.io/a/",
    "javascript:alert(1)",
    "https://user:pw@demo.ghost.io/a/",
    "https://demo.ghost.io:8443/a/",
    "/relative/",
    "https://127.0.0.1/a/",
    "",
  ];
  for (const url of hostile) {
    assert.throws(
      () => toConnectorItem(listItem({ url }), "demo.ghost.io"),
      (error: unknown) =>
        error instanceof GhostError && error.code === "LINK_INVALID",
      url,
    );
  }
});
