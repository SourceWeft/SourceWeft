import assert from "node:assert/strict";
import test from "node:test";
import { DiscourseError } from "../src/errors";
import { MAX_METADATA_AUTHORS, MAX_METADATA_POST_IDS } from "../src/limits";
import {
  buildCategoryTree,
  deepHashOf,
  isVisiblePost,
  lightHashOf,
  parseCategory,
  parsePost,
  parseTopicRow,
  toConnectorItem,
  type DiscourseCategory,
  type DiscoursePost,
  type DiscourseTopicRow,
} from "../src/model";

const BASE = "https://forum.example.com";

const cat = (
  id: number,
  name: string,
  parentId: number | null = null,
  readRestricted = false,
): DiscourseCategory => ({
  id,
  name,
  slug: name.toLowerCase(),
  parentId,
  readRestricted,
  topicCount: 0,
});

const row = (
  overrides: Partial<DiscourseTopicRow> = {},
): DiscourseTopicRow => ({
  ...parseTopicRow({
    id: 12,
    title: "Hello world",
    slug: "hello-world",
    category_id: 4,
    tags: ["b", "a"],
    posts_count: 3,
    highest_post_number: 3,
    created_at: "2026-01-01T00:00:00.000Z",
    last_posted_at: "2026-01-03T00:00:00.000Z",
    bumped_at: "2026-01-03T00:00:00.000Z",
  }),
  ...overrides,
});

const post = (
  id: number,
  overrides: Record<string, unknown> = {},
): DiscoursePost =>
  parsePost({
    id,
    post_number: id,
    username: `user${id}`,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    version: 1,
    cooked: "<p>x</p>",
    post_type: 1,
    ...overrides,
  });

// ---------------------------------------------------------------- tree

test("expand returns the selection and all its descendants", () => {
  const tree = buildCategoryTree([
    cat(1, "Root"),
    cat(2, "Child", 1),
    cat(3, "Grandchild", 2),
    cat(4, "Sibling", 1),
    cat(5, "Other"),
  ]);
  assert.deepEqual([...tree.expand([1])].sort(), [1, 2, 3, 4]);
  assert.deepEqual([...tree.expand([2])].sort(), [2, 3]);
  assert.deepEqual([...tree.expand([2, 5])].sort(), [2, 3, 5]);
});

test("expand ignores unknown ids and handles cycles", () => {
  const tree = buildCategoryTree([cat(1, "A", 2), cat(2, "B", 1), cat(3, "C")]);
  assert.deepEqual([...tree.expand([99])], []);
  assert.deepEqual([...tree.expand([1])].sort(), [1, 2]);
  assert.deepEqual([...tree.expand([3, 99])], [3]);
});

test("pathOf joins names from the root and terminates on cycles and orphans", () => {
  const tree = buildCategoryTree([
    cat(1, "Root"),
    cat(2, "Child", 1),
    cat(3, "Deep", 2),
    cat(7, "Orphan", 404),
    cat(8, "Loop A", 9),
    cat(9, "Loop B", 8),
  ]);
  assert.equal(tree.pathOf(3), "Root / Child / Deep");
  assert.equal(tree.pathOf(7), "Orphan");
  assert.equal(tree.pathOf(99), "");
  assert.equal(typeof tree.pathOf(8), "string");
  assert.ok(tree.pathOf(8).length < 50);
});

test("children are sorted case-insensitively; orphans are top level", () => {
  const tree = buildCategoryTree([
    cat(1, "banana"),
    cat(2, "Apple"),
    cat(3, "cherry"),
    cat(4, "Sub", 1),
    cat(5, "Orphan", 404),
  ]);
  assert.deepEqual(
    tree.children(null).map((c) => c.name),
    ["Apple", "banana", "cherry", "Orphan"],
  );
  assert.deepEqual(
    tree.children(1).map((c) => c.name),
    ["Sub"],
  );
  assert.deepEqual(tree.children(77), []);
});

test("isRestricted covers the category and every ancestor", () => {
  const tree = buildCategoryTree([
    cat(1, "Secret", null, true),
    cat(2, "Under secret", 1),
    cat(3, "Deeper", 2),
    cat(4, "Open"),
    cat(5, "Open child", 4),
    cat(6, "Loop A", 7),
    cat(7, "Loop B", 6),
  ]);
  assert.equal(tree.isRestricted(1), true);
  assert.equal(tree.isRestricted(3), true);
  assert.equal(tree.isRestricted(5), false);
  assert.equal(tree.isRestricted(99), false);
  assert.equal(tree.isRestricted(6), false);
});

test("the first category wins for a duplicate id", () => {
  const tree = buildCategoryTree([cat(1, "First"), cat(1, "Second")]);
  assert.equal(tree.pathOf(1), "First");
  assert.equal(tree.children(null).length, 1);
});

// ------------------------------------------------------------- parsers

test("parsers keep rejecting malformed objects with a fixed error", () => {
  for (const bad of [null, "x", 3, [], {}, { id: "1" }, { id: 0 }]) {
    assert.throws(
      () => parseCategory(bad),
      (error) =>
        error instanceof DiscourseError &&
        error.code === "DISCOURSE_BAD_RESPONSE",
    );
    assert.throws(() => parsePost(bad), DiscourseError);
    assert.throws(() => parseTopicRow(bad), DiscourseError);
  }
});

// ---------------------------------------------------------- visibility

test("isVisiblePost matrix", () => {
  assert.equal(isVisiblePost(post(1)), true);
  assert.equal(isVisiblePost(post(1, { post_type: 2 })), false); // moderator action
  assert.equal(isVisiblePost(post(1, { post_type: 3 })), false); // small action
  assert.equal(isVisiblePost(post(1, { post_type: 4 })), false); // whisper
  assert.equal(isVisiblePost(post(1, { hidden: true })), false);
  assert.equal(
    isVisiblePost(post(1, { deleted_at: "2026-01-02T00:00:00Z" })),
    false,
  );
  assert.equal(isVisiblePost(post(1, { user_deleted: true })), false);
});

// -------------------------------------------------------------- hashes

test("the light hash changes for each listed field", () => {
  const base = lightHashOf(row());
  assert.match(base, /^[0-9a-f]{64}$/);
  const variants: Array<Partial<DiscourseTopicRow>> = [
    { id: 13 },
    { title: "Other" },
    { categoryId: 5 },
    { categoryId: null },
    { tags: ["a"] },
    { tags: ["a", "b", "c"] },
    { closed: true },
    { archived: true },
    { postsCount: 4 },
    { highestPostNumber: 9 },
    { lastPostedAt: "2026-02-01T00:00:00.000Z" },
    { lastPostedAt: null },
  ];
  const seen = new Set([base]);
  for (const variant of variants) {
    const hash = lightHashOf(row(variant));
    assert.ok(
      !seen.has(hash),
      `${JSON.stringify(variant)} must change the hash`,
    );
    seen.add(hash);
  }
});

test("the light hash ignores bumpedAt, slug, order of tags and unlisted fields", () => {
  const base = lightHashOf(row());
  assert.equal(lightHashOf(row({ bumpedAt: "2030-01-01T00:00:00Z" })), base);
  assert.equal(lightHashOf(row({ slug: "renamed" })), base);
  assert.equal(lightHashOf(row({ tags: ["a", "b"] })), base);
  assert.equal(lightHashOf(row({ createdAt: null })), base);
});

test("the deep hash differs from the light hash and tracks post versions", () => {
  const posts = [post(1), post(2), post(3)];
  const deep = deepHashOf(row(), posts);
  assert.notEqual(deep, lightHashOf(row()));
  assert.equal(deepHashOf(row(), [...posts].reverse()), deep);
  assert.notEqual(
    deepHashOf(row(), [post(1), post(2, { version: 2 }), post(3)]),
    deep,
  );
  assert.notEqual(
    deepHashOf(row(), [
      post(1),
      post(2, { updated_at: "2026-05-01T00:00:00.000Z" }),
      post(3),
    ]),
    deep,
  );
  assert.notEqual(deepHashOf(row(), [post(1), post(2)]), deep);
  assert.notEqual(deepHashOf(row({ closed: true }), posts), deep);
});

test("the deep hash covers only visible posts", () => {
  const visible = [post(1), post(2)];
  const withNoise = [
    ...visible,
    post(3, { post_type: 4 }),
    post(4, { hidden: true }),
    post(5, { deleted_at: "2026-01-02T00:00:00Z" }),
    post(6, { user_deleted: true }),
  ];
  assert.equal(deepHashOf(row(), withNoise), deepHashOf(row(), visible));
  assert.equal(
    deepHashOf(row(), []),
    deepHashOf(row(), [post(9, { hidden: true })]),
  );
});

test("a refresh mode switch changes the hash for the same topic", () => {
  assert.notEqual(lightHashOf(row()), deepHashOf(row(), []));
});

test("hashes cap the tag list exactly as the stored metadata does", () => {
  const tags = Array.from({ length: 150 }, (_, i) => `t${i}`);
  const a = lightHashOf(row({ tags }));
  const b = lightHashOf(row({ tags: tags.slice(0, 100) }));
  assert.equal(a, b);
});

// --------------------------------------------------------- item building

const input = (overrides: Record<string, unknown> = {}) => ({
  base: BASE,
  categoryPath: "Support / Setup",
  refresh: "light" as const,
  hash: "abc",
  postIds: [101, 102],
  authors: ["alice", "bob"],
  ...overrides,
});

test("toConnectorItem builds the identity, link and metadata", () => {
  const item = toConnectorItem(row(), input());
  assert.equal(item.externalId, "discourse:topic:12");
  assert.equal(item.externalUri, `${BASE}/t/hello-world/12`);
  assert.equal(item.title, "Hello world");
  assert.equal(item.mimeType, "text/markdown");
  assert.equal(item.sizeBytes, null);
  assert.equal(item.contentHash, "abc");
  assert.deepEqual(
    item.externalUpdatedAt,
    new Date("2026-01-03T00:00:00.000Z"),
  );
  assert.deepEqual(item.metadata, {
    topicId: 12,
    slug: "hello-world",
    categoryId: 4,
    categoryPath: "Support / Setup",
    tags: ["b", "a"],
    postsCount: 3,
    lastPostedAt: "2026-01-03T00:00:00.000Z",
    closed: false,
    archived: false,
    postIds: [101, 102],
    authors: ["alice", "bob"],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
});

test("toConnectorItem records omittedPosts only when posts were left out", () => {
  const none = toConnectorItem(row(), input());
  assert.equal("omittedPosts" in none.metadata, false);
  const zero = toConnectorItem(row(), input({ omittedPosts: 0 }));
  assert.equal("omittedPosts" in zero.metadata, false);
  const some = toConnectorItem(row(), input({ omittedPosts: 7 }));
  assert.equal(some.metadata.omittedPosts, 7);
});

test("toConnectorItem omits missing fields and falls back for the title", () => {
  const bare = row({
    title: "   ",
    slug: "",
    categoryId: null,
    tags: [],
    createdAt: null,
    lastPostedAt: null,
    bumpedAt: null,
  });
  const item = toConnectorItem(
    bare,
    input({ categoryPath: "", postIds: [], authors: [] }),
  );
  assert.equal(item.title, "Untitled topic");
  assert.equal(item.externalUri, `${BASE}/t/topic/12`);
  assert.equal(item.externalUpdatedAt, null);
  assert.deepEqual(item.metadata, {
    topicId: 12,
    slug: "topic",
    postsCount: 3,
    closed: false,
    archived: false,
  });
  for (const value of Object.values(item.metadata)) {
    assert.notEqual(value, undefined);
    assert.notEqual(value, "");
  }
});

test("toConnectorItem caps strings and lists and dedupes authors", () => {
  const long = "x".repeat(5_000);
  const item = toConnectorItem(
    row({
      title: long,
      tags: [long, "", "  ", ...Array.from({ length: 200 }, (_, i) => `t${i}`)],
    }),
    input({
      categoryPath: long,
      postIds: Array.from({ length: 700 }, (_, i) => i + 1),
      authors: [...Array.from({ length: 300 }, (_, i) => `a${i % 150}`), long],
    }),
  );
  assert.equal(item.title.length, 1_000);
  const md = item.metadata as Record<string, unknown>;
  assert.equal((md.categoryPath as string).length, 2_000);
  const tags = md.tags as string[];
  assert.equal(tags.length, 100);
  assert.equal(tags[0]?.length, 2_000);
  assert.equal((md.postIds as number[]).length, MAX_METADATA_POST_IDS);
  const authors = md.authors as string[];
  assert.equal(authors.length, MAX_METADATA_AUTHORS);
  assert.equal(new Set(authors).size, authors.length);
});

test("toConnectorItem never trusts a hostile slug or title", () => {
  const item = toConnectorItem(
    row({ slug: "../../evil?x=1#y", title: "a\nb\u2028c" }),
    input(),
  );
  assert.equal(item.externalUri, `${BASE}/t/topic/12`);
  assert.equal((item.metadata as Record<string, unknown>).slug, "topic");
  assert.equal(item.title, "a b c");
});

test("the hash helper agrees with the capped tags stored in metadata", () => {
  const tags = Array.from({ length: 150 }, (_, i) => `t${i}`);
  const r = row({ tags });
  const item = toConnectorItem(r, input({ hash: lightHashOf(r) }));
  const stored = (item.metadata as { tags: string[] }).tags;
  assert.equal(lightHashOf(row({ tags: stored })), item.contentHash);
});
