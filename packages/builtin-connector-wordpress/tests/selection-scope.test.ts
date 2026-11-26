import assert from "node:assert/strict";
import test from "node:test";
import { WordPressError } from "../src/errors";
import type { WpTerm } from "../src/model";
import { resolveScope } from "../src/selection-scope";

/**
 * A small category tree:
 *   10 (root) ─ 11 (child) ─ 12 (grandchild)
 *   13 (root, a sibling of 10)
 */
const TREE: WpTerm[] = [
  { id: 10, name: "Tech", parent: 0 },
  { id: 11, name: "Web", parent: 10 },
  { id: 12, name: "CSS", parent: 11 },
  { id: 13, name: "Life", parent: 0 },
];

const item = (id: string): { id: string; kind: string } => ({
  id,
  kind: id.split(":")[0] ?? "",
});

test("an empty selection means all posts and all pages", () => {
  assert.deepEqual(resolveScope([], TREE), {
    posts: { all: true, categoryIds: null, postIds: [] },
    pages: { all: true, pageIds: [] },
  });
});

test("type:post selects all posts only, type:page all pages only", () => {
  assert.deepEqual(resolveScope([item("type:post")], TREE), {
    posts: { all: true, categoryIds: null, postIds: [] },
    pages: { all: false, pageIds: [] },
  });
  assert.deepEqual(resolveScope([item("type:page")], TREE), {
    posts: { all: false, categoryIds: null, postIds: [] },
    pages: { all: true, pageIds: [] },
  });
});

test("a category expands to its subtree and applies to posts only", () => {
  const scope = resolveScope([item("category:10")], TREE);
  assert.deepEqual(scope.posts.categoryIds, [10, 11, 12]);
  assert.equal(scope.posts.all, false);
  assert.deepEqual(scope.posts.postIds, []);
  assert.deepEqual(scope.pages, { all: false, pageIds: [] });
});

test("a selected child category does not pull in its siblings", () => {
  const scope = resolveScope([item("category:11")], TREE);
  assert.deepEqual(scope.posts.categoryIds, [11, 12]);
});

test("a deleted category expands to just itself (so it matches nothing)", () => {
  const scope = resolveScope([item("category:99")], TREE);
  assert.deepEqual(scope.posts.categoryIds, [99]);
});

test("single posts and pages select by id", () => {
  const scope = resolveScope(
    [item("post:3"), item("post:1"), item("page:7")],
    TREE,
  );
  assert.deepEqual(scope.posts, {
    all: false,
    categoryIds: null,
    postIds: [1, 3],
  });
  assert.deepEqual(scope.pages, { all: false, pageIds: [7] });
});

test("category and single-post selections combine", () => {
  const scope = resolveScope([item("category:11"), item("post:5")], TREE);
  assert.deepEqual(scope.posts, {
    all: false,
    categoryIds: [11, 12],
    postIds: [5],
  });
});

test("when a type is all, narrower selections of that type are dropped", () => {
  const scope = resolveScope(
    [item("type:post"), item("category:10"), item("post:5"), item("page:7")],
    TREE,
  );
  assert.deepEqual(scope.posts, { all: true, categoryIds: null, postIds: [] });
  assert.deepEqual(scope.pages, { all: false, pageIds: [7] });
  const pageScope = resolveScope([item("type:page"), item("page:7")], TREE);
  assert.deepEqual(pageScope.pages, { all: true, pageIds: [] });
});

test("duplicate selections are de-duplicated", () => {
  const scope = resolveScope(
    [item("post:5"), item("post:5"), item("category:10"), item("category:10")],
    TREE,
  );
  assert.deepEqual(scope.posts.postIds, [5]);
  assert.deepEqual(scope.posts.categoryIds, [10, 11, 12]);
});

test("a category cycle does not loop forever", () => {
  const cyclic: WpTerm[] = [
    { id: 1, name: "A", parent: 2 },
    { id: 2, name: "B", parent: 1 },
  ];
  assert.deepEqual(
    resolveScope([item("category:1")], cyclic).posts.categoryIds,
    [1, 2],
  );
});

test("a malformed selection id is CONFIG_INVALID", () => {
  for (const bad of ["post:0", "tag:1", "type:draft", "post:x", "post:"]) {
    assert.throws(
      () => resolveScope([{ id: bad, kind: bad.split(":")[0] ?? "" }], TREE),
      (error: unknown) =>
        error instanceof WordPressError && error.code === "CONFIG_INVALID",
      bad,
    );
  }
  // The kind must agree with the id prefix.
  assert.throws(
    () => resolveScope([{ id: "post:5", kind: "page" }], TREE),
    (error: unknown) =>
      error instanceof WordPressError && error.code === "CONFIG_INVALID",
  );
});
