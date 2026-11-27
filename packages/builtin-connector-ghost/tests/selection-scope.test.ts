import assert from "node:assert/strict";
import test from "node:test";
import { GhostError } from "../src/errors";
import { resolveScope } from "../src/selection-scope";

const A = "0000000000000000000000aa";
const B = "0000000000000000000000bb";
const C = "0000000000000000000000cc";

test("an empty selection means all posts and all pages", () => {
  assert.deepEqual(resolveScope([]), {
    posts: { all: true, tagIds: [], ids: [] },
    pages: { all: true, tagIds: [], ids: [] },
  });
});

test("type:post is only posts and type:page only pages", () => {
  assert.deepEqual(resolveScope([{ id: "type:post", kind: "type" }]), {
    posts: { all: true, tagIds: [], ids: [] },
    pages: { all: false, tagIds: [], ids: [] },
  });
  assert.deepEqual(resolveScope([{ id: "type:page", kind: "type" }]), {
    posts: { all: false, tagIds: [], ids: [] },
    pages: { all: true, tagIds: [], ids: [] },
  });
});

test("a tag applies to both routes, sorted and unique", () => {
  const scope = resolveScope([
    { id: `tag:${B}`, kind: "tag" },
    { id: `tag:${A}`, kind: "tag" },
    { id: `tag:${B}`, kind: "tag" },
  ]);
  assert.deepEqual(scope, {
    posts: { all: false, tagIds: [A, B], ids: [] },
    pages: { all: false, tagIds: [A, B], ids: [] },
  });
});

test("singles select on their own route", () => {
  const scope = resolveScope([
    { id: `post:${B}`, kind: "post" },
    { id: `page:${C}`, kind: "page" },
    { id: `post:${A}`, kind: "post" },
  ]);
  assert.deepEqual(scope, {
    posts: { all: false, tagIds: [], ids: [A, B] },
    pages: { all: false, tagIds: [], ids: [C] },
  });
});

test("a whole type makes its tags and singles redundant", () => {
  const scope = resolveScope([
    { id: "type:post", kind: "type" },
    { id: `tag:${A}`, kind: "tag" },
    { id: `post:${B}`, kind: "post" },
    { id: `page:${C}`, kind: "page" },
  ]);
  assert.deepEqual(scope, {
    posts: { all: true, tagIds: [], ids: [] },
    pages: { all: false, tagIds: [A], ids: [C] },
  });
});

test("a malformed id or a kind that differs from the prefix is CONFIG_INVALID", () => {
  const bad = [
    { id: "type:tag", kind: "type" },
    { id: "post:123", kind: "post" },
    { id: `post:${A.toUpperCase()}`, kind: "post" },
    { id: `post:${A}`, kind: "page" },
    { id: "type:post", kind: "post" },
    { id: `tag:${A}`, kind: "type" },
  ];
  for (const item of bad) {
    assert.throws(
      () => resolveScope([item]),
      (e: unknown) => e instanceof GhostError && e.code === "CONFIG_INVALID",
      JSON.stringify(item),
    );
  }
});
