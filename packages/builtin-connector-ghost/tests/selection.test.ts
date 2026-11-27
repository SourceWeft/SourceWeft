import assert from "node:assert/strict";
import test from "node:test";
import {
  connectorSelectionBrowseResultSchema,
  connectorSelectionDescribeResultSchema,
  connectorSelectionSearchResultSchema,
} from "@sourceweft/contracts";
import { GhostAdapterError } from "../src/adapter-error";
import { createGhostClient, type GhostClient } from "../src/client";
import { GhostError } from "../src/errors";
import { MAX_TAG_PAGES, PAGE_SIZE } from "../src/limits";
import {
  browseSelection,
  describeSelection,
  searchSelection,
} from "../src/selection";
import {
  createFakeGhost,
  DEFAULT_KEY,
  hexId,
  sampleState,
  type FakeGhost,
  type FakeItem,
  type FakeTag,
} from "./helpers/fake-ghost";

const SITE = "https://site.example";

type Harness = { fake: FakeGhost; client: GhostClient };

function harness(
  state: {
    items?: FakeItem[];
    tags?: FakeTag[];
  } = {},
): Harness {
  const base = sampleState();
  const fake = createFakeGhost({
    siteBase: SITE,
    key: DEFAULT_KEY,
    ...base,
    ...state,
  });
  const client = createGhostClient({
    fetch: fake.fetch,
    siteBase: SITE,
    key: DEFAULT_KEY,
    sleep: async () => undefined,
    limits: { minRequestGapMs: 0 },
  });
  return { fake, client };
}

const manyTags = (count: number): FakeTag[] =>
  Array.from({ length: count }, (_, i) => ({
    id: hexId(0x1000 + i),
    name: `Tag ${String(i).padStart(4, "0")}`,
    slug: `tag-${i}`,
  }));

async function invalid(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GhostAdapterError, String(error));
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "GHOST_INVALID_REQUEST");
    return;
  }
  assert.fail("expected an invalid request");
}

test("browse lists the two types, then the tags, with no container below the root", async () => {
  const { fake, client } = harness();
  const result = await browseSelection({ client, request: {} });
  assert.deepEqual(connectorSelectionBrowseResultSchema.parse(result), result);
  assert.equal(result.container, null);
  assert.deepEqual(result.breadcrumbs, []);
  assert.deepEqual(
    result.entries.map((e) => [e.id, e.kind, e.name]),
    [
      ["type:post", "type", "All posts"],
      ["type:page", "type", "All pages"],
      [`tag:${hexId(0x101)}`, "tag", "News"],
      [`tag:${hexId(0x102)}`, "tag", "Guides"],
    ],
  );
  for (const entry of result.entries) {
    assert.equal(entry.selectable, true);
    assert.equal(entry.expandable, false);
    assert.equal(entry.disabledReason, null);
  }
  assert.equal(result.hasMore, false);
  assert.equal(result.cursor, "");
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0]!.path, "/ghost/api/content/tags/");
});

test("browse accepts a null container and rejects any container, cursor or shape it cannot honour", async () => {
  const { client } = harness();
  const ok = await browseSelection({
    client,
    request: { containerId: null, cursor: "" },
  });
  assert.equal(ok.entries.length, 4);
  for (const request of [
    { containerId: `tag:${hexId(0x101)}` },
    { containerId: "type:post" },
    { containerId: 5 },
    { cursor: 5 },
    { cursor: "not a cursor" },
    { cursor: "x".repeat(4097) },
    // A well-formed base64url that is not our cursor.
    { cursor: Buffer.from('{"o":-1}').toString("base64url") },
    { cursor: Buffer.from('{"o":1.5}').toString("base64url") },
    { cursor: Buffer.from('{"o":1,"x":1}').toString("base64url") },
    { cursor: Buffer.from('{"p":1}').toString("base64url") },
  ]) {
    await invalid(browseSelection({ client, request }));
  }
});

test("a tag without a name is shown by its slug", async () => {
  const { client } = harness({
    tags: [{ id: hexId(0x101), name: "", slug: "unnamed" }],
  });
  const result = await browseSelection({ client, request: {} });
  assert.equal(result.entries[2]!.name, "unnamed");
});

test("browse pages through every tag, at most 500 entries and MAX_TAG_PAGES requests per call", async () => {
  const total = 1_234;
  const { fake, client } = harness({ tags: manyTags(total) });
  const seen: string[] = [];
  let cursor = "";
  let calls = 0;
  for (;;) {
    const before = fake.requests.length;
    const result = await browseSelection({
      client,
      request: cursor === "" ? {} : { cursor },
    });
    assert.deepEqual(
      connectorSelectionBrowseResultSchema.parse(result),
      result,
    );
    assert.ok(result.entries.length <= 500, String(result.entries.length));
    assert.ok(fake.requests.length - before <= MAX_TAG_PAGES);
    for (const entry of result.entries) {
      if (entry.kind === "tag") seen.push(entry.id);
      else assert.equal(calls, 0, "the types only open the first result");
    }
    calls += 1;
    if (!result.hasMore) {
      assert.equal(result.cursor, "");
      break;
    }
    assert.notEqual(result.cursor, "");
    cursor = result.cursor;
    assert.ok(calls < 20, "must terminate");
  }
  assert.equal(seen.length, total);
  assert.equal(new Set(seen).size, total);
  assert.deepEqual(
    seen,
    Array.from({ length: total }, (_, i) => `tag:${hexId(0x1000 + i)}`),
  );
  // 498 tags with the types, then 402 (pages 5 to 9), then the last 334.
  assert.equal(calls, 3);
});

test("browse stops at the tag list's end without claiming more", async () => {
  const { client } = harness({ tags: manyTags(PAGE_SIZE * 2) });
  const result = await browseSelection({ client, request: {} });
  assert.equal(result.entries.length, 2 + PAGE_SIZE * 2);
  assert.equal(result.hasMore, false);
});

test("browse never loops on a site that promises pages it does not serve", async () => {
  const { fake, client } = harness({ tags: manyTags(3) });
  fake.failNext(
    {
      status: 200,
      body: JSON.stringify({
        tags: [],
        meta: {
          pagination: { page: 1, limit: 100, pages: 9, total: 900 },
        },
      }),
    },
    MAX_TAG_PAGES,
  );
  const result = await browseSelection({ client, request: {} });
  assert.equal(result.hasMore, false);
  assert.equal(result.cursor, "");
});

test("search finds posts and pages by title with kind-qualified ids", async () => {
  const { fake, client } = harness({
    items: [
      { id: hexId(1), type: "post", title: "Hello post" },
      { id: hexId(2), type: "page", title: "Hello page" },
      { id: hexId(3), type: "post", title: "Unrelated" },
      { id: hexId(4), type: "post", title: "Hello again" },
    ],
  });
  const result = await searchSelection({
    client,
    request: { query: "  Hello " },
  });
  assert.deepEqual(connectorSelectionSearchResultSchema.parse(result), result);
  assert.deepEqual(
    result.entries.map((e) => [e.id, e.kind, e.name]),
    [
      [`post:${hexId(1)}`, "post", "Hello post"],
      [`post:${hexId(4)}`, "post", "Hello again"],
      [`page:${hexId(2)}`, "page", "Hello page"],
    ],
  );
  assert.equal(result.hasMore, false);
  assert.equal(result.cursor, "");
  assert.deepEqual(
    fake.requests.map((r) => r.path),
    ["/ghost/api/content/posts/", "/ghost/api/content/pages/"],
  );
  assert.ok(
    fake.requests.every((r) => r.query.filter === "title:~'Hello'"),
    "the query is trimmed",
  );
});

test("search escapes a quote and a backslash in the title filter", async () => {
  const { fake, client } = harness({
    items: [{ id: hexId(1), type: "post", title: "It's a trap" }],
  });
  const result = await searchSelection({
    client,
    request: { query: "It's" },
  });
  assert.deepEqual(
    result.entries.map((e) => e.id),
    [`post:${hexId(1)}`],
  );
  await searchSelection({ client, request: { query: "a\\' or id:~'" } });
  assert.equal(
    fake.requests.at(-1)!.query.filter,
    "title:~'a\\\\\\' or id:~\\''",
  );
});

test("search pages through both lists with an opaque cursor", async () => {
  const items: FakeItem[] = [
    ...Array.from({ length: 150 }, (_, i): FakeItem => ({
      id: hexId(100 + i),
      type: "post",
      title: `Match post ${i}`,
    })),
    ...Array.from({ length: 30 }, (_, i): FakeItem => ({
      id: hexId(1000 + i),
      type: "page",
      title: `Match page ${i}`,
    })),
  ];
  const { fake, client } = harness({ items });
  const first = await searchSelection({ client, request: { query: "Match" } });
  assert.equal(first.hasMore, true);
  assert.notEqual(first.cursor, "");
  assert.equal(first.entries.length, 100 + 30);
  const requestsAfterFirst = fake.requests.length;
  const second = await searchSelection({
    client,
    request: { query: "Match", cursor: first.cursor },
  });
  assert.equal(second.hasMore, false);
  assert.equal(second.cursor, "");
  assert.equal(second.entries.length, 50);
  // Page 2 exists for posts only: the pages list is not asked again.
  assert.deepEqual(
    fake.requests.slice(requestsAfterFirst).map((r) => r.path),
    ["/ghost/api/content/posts/"],
  );
  const ids = [...first.entries, ...second.entries].map((e) => e.id);
  assert.equal(new Set(ids).size, 180);
});

test("search rejects a missing, empty or oversized query and a forged cursor", async () => {
  const { client } = harness();
  for (const request of [
    {},
    { query: 5 },
    { query: "" },
    { query: "   " },
    { query: "x".repeat(201) },
    { query: "a", cursor: 5 },
    { query: "a", cursor: "nope" },
    { query: "a", cursor: "x".repeat(4097) },
    {
      query: "a",
      cursor: Buffer.from('{"p":0,"a":1,"b":1}').toString("base64url"),
    },
    {
      query: "a",
      cursor: Buffer.from('{"p":2,"a":-1,"b":1}').toString("base64url"),
    },
    { query: "a", cursor: Buffer.from('{"p":2}').toString("base64url") },
    { query: "a", cursor: Buffer.from('{"o":2}').toString("base64url") },
  ]) {
    await invalid(searchSelection({ client, request }));
  }
});

test("describe maps types, tags, posts and pages to titles and omits unknown ids", async () => {
  const { fake, client } = harness();
  const unknownTag = `tag:${hexId(0x999)}`;
  const unknownPost = `post:${hexId(0x998)}`;
  const ids = [
    "type:page",
    `tag:${hexId(0x102)}`,
    unknownTag,
    `post:${hexId(1)}`,
    unknownPost,
    // A page id is not found among posts, and a post id not among pages.
    `page:${hexId(1)}`,
    `page:${hexId(3)}`,
    "type:post",
  ];
  const result = await describeSelection({ client, request: { ids } });
  assert.deepEqual(
    connectorSelectionDescribeResultSchema.parse(result),
    result,
  );
  assert.deepEqual(
    result.items.map((i) => [i.id, i.kind, i.name, i.exists]),
    [
      ["type:page", "type", "All pages", true],
      [`tag:${hexId(0x102)}`, "tag", "Guides", true],
      [`post:${hexId(1)}`, "post", "First", true],
      [`page:${hexId(3)}`, "page", "About", true],
      ["type:post", "type", "All posts", true],
    ],
  );
  // One request per kind present, each with an id filter in request order.
  assert.deepEqual(fake.requests.map((r) => [r.path, r.query.filter]).sort(), [
    ["/ghost/api/content/pages/", `id:[${hexId(1)},${hexId(3)}]`],
    ["/ghost/api/content/posts/", `id:[${hexId(1)},${hexId(0x998)}]`],
    ["/ghost/api/content/tags/", `id:[${hexId(0x102)},${hexId(0x999)}]`],
  ]);
});

test("describe of types alone makes no request", async () => {
  const { fake, client } = harness();
  await describeSelection({
    client,
    request: { ids: ["type:post", "type:page"] },
  });
  assert.equal(fake.requests.length, 0);
});

test("describe answers a repeated id once and keeps the request order", async () => {
  const { client } = harness();
  const result = await describeSelection({
    client,
    request: {
      ids: [`post:${hexId(2)}`, `post:${hexId(1)}`, `post:${hexId(2)}`],
    },
  });
  assert.deepEqual(
    result.items.map((i) => i.id),
    [`post:${hexId(2)}`, `post:${hexId(1)}`],
  );
});

test("describe handles a full 100-id request in one request per kind", async () => {
  const items = Array.from({ length: 100 }, (_, i): FakeItem => ({
    id: hexId(500 + i),
    type: "post",
    title: `Post ${i}`,
  }));
  const { fake, client } = harness({ items });
  const result = await describeSelection({
    client,
    request: { ids: items.map((i) => `post:${i.id}`) },
  });
  assert.equal(result.items.length, 100);
  assert.equal(fake.requests.length, 1);
});

test("describe shows an untitled item as Untitled", async () => {
  const { client } = harness({
    items: [{ id: hexId(7), type: "post", title: "" }],
  });
  const result = await describeSelection({
    client,
    request: { ids: [`post:${hexId(7)}`] },
  });
  assert.equal(result.items[0]!.name, "Untitled");
});

test("describe rejects a missing, empty, oversized or malformed ids list", async () => {
  const { client } = harness();
  const tooMany = Array.from({ length: 101 }, (_, i) => `post:${hexId(i)}`);
  for (const request of [
    {},
    { ids: "type:post" },
    { ids: [] },
    { ids: tooMany },
    { ids: [5] },
    { ids: ["post:123"] },
    { ids: ["post:" + "A".repeat(24)] },
    { ids: ["category:" + hexId(1)] },
    { ids: ["type:tag"] },
    { ids: [`post:${hexId(1)}`, "nope"] },
  ]) {
    await invalid(describeSelection({ client, request }));
  }
});

test("a site error in a selection action is a fixed Ghost error, not a request error", async () => {
  const { fake, client } = harness();
  fake.failNext({ status: 500 }, 5);
  await assert.rejects(
    browseSelection({ client, request: {} }),
    (error: unknown) => {
      assert.ok(error instanceof GhostError);
      assert.equal(error.code, "BAD_RESPONSE");
      return true;
    },
  );
});
