import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConnectorSelectionBrowseResult,
  ConnectorSelectionDescribeResult,
  ConnectorSelectionSearchResult,
} from "@sourceweft/contracts";
import { WordPressAdapterError } from "../src/adapter";
import {
  actionInput,
  fakePost,
  harness,
  manyEntries,
  wpConfig,
} from "./helpers/adapter-fixtures";
import type { FakeCategory } from "./helpers/fake-wordpress";

const CATEGORIES: FakeCategory[] = [
  { id: 10, name: "News", parent: 0 },
  { id: 11, name: "World", parent: 10 },
  { id: 12, name: "Sports", parent: 0 },
];

const browse = (
  request: Record<string, unknown>,
  posts = [fakePost(1), { id: 3, type: "page" as const, title: "About" }],
) =>
  harness({
    flavor: "public",
    fake: { categories: CATEGORIES, posts },
  }).adapter.executeAction(
    actionInput("wordpress.browse", request, wpConfig()),
  );

async function browseResult(
  request: Record<string, unknown>,
): Promise<ConnectorSelectionBrowseResult> {
  const { result } = await browse(request);
  return result as unknown as ConnectorSelectionBrowseResult;
}

test("browse root lists All posts, All pages and the top-level categories", async () => {
  const result = await browseResult({});
  assert.equal(result.container, null);
  assert.deepEqual(
    result.entries.map((e) => [e.id, e.kind, e.name, e.expandable]),
    [
      ["type:post", "type", "All posts", false],
      ["type:page", "type", "All pages", false],
      ["category:10", "category", "News", true], // News has subcategory World
      ["category:12", "category", "Sports", false],
    ],
  );
  assert.equal(result.hasMore, false);
  assert.equal(result.cursor, "");
});

test("browse a category container lists its subcategories with breadcrumbs", async () => {
  const result = await browseResult({ containerId: "category:10" });
  assert.deepEqual(result.container, {
    id: "category:10",
    kind: "category",
    name: "News",
    detail: null,
  });
  assert.deepEqual(result.breadcrumbs, []);
  assert.deepEqual(
    result.entries.map((e) => [e.id, e.name]),
    [["category:11", "World"]],
  );

  const child = await browseResult({ containerId: "category:11" });
  assert.deepEqual(child.breadcrumbs, [{ id: "category:10", name: "News" }]);
  assert.deepEqual(child.entries, []);
});

test("browse rejects a malformed container id or a stray cursor", async () => {
  for (const request of [
    { containerId: "post:1" },
    { containerId: "category:0" },
    { containerId: 5 },
    { cursor: "deadbeef" },
  ]) {
    await assert.rejects(
      () => browse(request),
      (error: unknown) =>
        error instanceof WordPressAdapterError &&
        error.code === "WORDPRESS_INVALID_REQUEST",
    );
  }
});

// ---- search --------------------------------------------------------------

async function searchResult(
  request: Record<string, unknown>,
  posts = manyEntries(90, 20),
): Promise<ConnectorSelectionSearchResult> {
  const { result } = await harness({
    flavor: "public",
    fake: { categories: CATEGORIES, posts },
  }).adapter.executeAction(
    actionInput("wordpress.search", request, wpConfig()),
  );
  return result as unknown as ConnectorSelectionSearchResult;
}

test("search returns posts and pages as kind-qualified entries and pages through", async () => {
  const first = await searchResult({ query: "Entry" });
  assert.equal(first.entries.length, 100);
  const kinds = new Set(first.entries.map((e) => e.kind));
  assert.ok(kinds.has("post") && kinds.has("page"), "both kinds appear");
  assert.ok(
    first.entries.every((e) => /^(post|page):[0-9]+$/.test(e.id)),
    "ids are kind-qualified",
  );
  assert.equal(first.hasMore, true);
  assert.notEqual(first.cursor, "");

  const second = await searchResult({ query: "Entry", cursor: first.cursor });
  assert.equal(second.entries.length, 10);
  assert.equal(second.hasMore, false);
  assert.equal(second.cursor, "");
});

test("search drops a hit whose link points at another host", async () => {
  const posts = [
    fakePost(1, { title: "Keeper" }),
    fakePost(2, { title: "Keeper two", link: "https://evil.example/p/2" }),
  ];
  const result = await searchResult({ query: "Keeper" }, posts);
  assert.deepEqual(
    result.entries.map((e) => e.id),
    ["post:1"],
  );
});

test("search validates its query", async () => {
  for (const request of [{}, { query: "" }, { query: "x".repeat(201) }]) {
    await assert.rejects(
      () =>
        harness({
          flavor: "public",
          fake: { categories: CATEGORIES },
        }).adapter.executeAction(
          actionInput("wordpress.search", request, wpConfig()),
        ),
      (error: unknown) =>
        error instanceof WordPressAdapterError &&
        error.code === "WORDPRESS_INVALID_REQUEST",
    );
  }
});

// ---- describe ------------------------------------------------------------

async function describeResult(
  ids: unknown,
): Promise<ConnectorSelectionDescribeResult> {
  const { result } = await harness({
    flavor: "public",
    fake: {
      categories: CATEGORIES,
      posts: [fakePost(1, { title: "Hello" })],
    },
  }).adapter.executeAction(
    actionInput("wordpress.describe", { ids }, wpConfig()),
  );
  return result as unknown as ConnectorSelectionDescribeResult;
}

test("describe maps known ids to titles and tombstones the unknown, in order", async () => {
  const result = await describeResult([
    "type:post",
    "category:10",
    "category:999",
    "post:1",
    "post:9999",
    "page:9999",
  ]);
  // One item per requested id, in request order; unknown ids are tombstones.
  assert.deepEqual(
    result.items.map((i) => [i.id, i.kind, i.name, i.exists]),
    [
      ["type:post", "type", "All posts", true],
      ["category:10", "category", "News", true],
      ["category:999", "category", null, false],
      ["post:1", "post", "Hello", true],
      ["post:9999", "post", null, false],
      ["page:9999", "page", null, false],
    ],
  );
  // The tombstone carries the exact ConnectorSelectionDescribeItem field set.
  assert.deepEqual(result.items[2], {
    id: "category:999",
    kind: "category",
    name: null,
    detail: null,
    exists: false,
    meta: {},
  });
});

test("describe keeps the 100-id bound", async () => {
  const ids = Array.from({ length: 100 }, (_, i) => `post:${i + 1}`);
  const result = await describeResult(ids);
  assert.equal(result.items.length, 100);
  await assert.rejects(
    () => describeResult([...ids, "post:101"]),
    (error: unknown) =>
      error instanceof WordPressAdapterError &&
      error.code === "WORDPRESS_INVALID_REQUEST",
  );
});

test("describe validates its ids", async () => {
  for (const ids of [[], "post:1", [5], ["bogus"]]) {
    await assert.rejects(
      () => describeResult(ids),
      (error: unknown) =>
        error instanceof WordPressAdapterError &&
        error.code === "WORDPRESS_INVALID_REQUEST",
    );
  }
});
