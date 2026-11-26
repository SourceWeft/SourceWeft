import assert from "node:assert/strict";
import test from "node:test";
import {
  connectorSelectionBrowseResultSchema,
  connectorSelectionDescribeResultSchema,
  connectorSelectionSearchResultSchema,
} from "@sourceweft/contracts";
import { createDiscourseAdapter, DiscourseAdapterError } from "../src/adapter";
import {
  adapterForum,
  baseInput,
  fakeTopic,
  forumConfig,
  harness,
  type Harness,
} from "./helpers/adapter-fixtures";

async function run(
  h: Harness,
  actionType: string,
  request: Record<string, unknown>,
) {
  const result = await h.adapter.executeAction({
    ...baseInput(forumConfig([])),
    actionType,
    request,
    idempotencyKey: "k",
  });
  return result.result;
}

async function browse(h: Harness, request: Record<string, unknown> = {}) {
  return connectorSelectionBrowseResultSchema.parse(
    await run(h, "discourse.browse", request),
  );
}

async function search(h: Harness, request: Record<string, unknown>) {
  return connectorSelectionSearchResultSchema.parse(
    await run(h, "discourse.search", request),
  );
}

async function describe(h: Harness, request: Record<string, unknown>) {
  return connectorSelectionDescribeResultSchema.parse(
    await run(h, "discourse.describe", request),
  );
}

const isInvalidRequest = (error: unknown) => {
  assert.ok(error instanceof DiscourseAdapterError);
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, "DISCOURSE_INVALID_REQUEST");
  assert.ok(!/example|category:|topic:/.test(error.message));
  return true;
};

const cursorOf = (page: number) =>
  Buffer.from(JSON.stringify({ p: page }), "utf8").toString("base64url");

// ---- browse -----------------------------------------------------------------

test("browse root lists top-level categories sorted, restricted ones disabled", async () => {
  const h = harness(adapterForum());
  const result = await browse(h);
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ["alpha", "Empty", "General", "Staff"],
  );
  assert.deepEqual(result.entries[2], {
    id: "category:10",
    kind: "category",
    name: "General",
    detail: null,
    selectable: true,
    expandable: true,
    disabledReason: null,
    size: null,
    modifiedAt: null,
  });
  // alpha has topics; Empty has neither children nor topics.
  assert.equal(result.entries[0]!.expandable, true);
  assert.equal(result.entries[1]!.expandable, false);
  const staff = result.entries[3]!;
  assert.equal(staff.id, "category:12");
  assert.equal(staff.selectable, false);
  assert.equal(staff.disabledReason, "restricted");
  assert.equal(staff.expandable, false);
  assert.equal(result.container, null);
  assert.deepEqual(result.breadcrumbs, []);
  assert.equal(result.cursor, "");
  assert.equal(result.hasMore, false);
  assert.equal(h.closed(), h.opened());
  // The root listing reads only site.json.
  assert.deepEqual(
    h.fake.requests.map((r) => r.path),
    ["/site.json"],
  );
});

test("browse of containerId null is the root", async () => {
  const h = harness(adapterForum());
  assert.equal((await browse(h, { containerId: null })).container, null);
});

test("browse a category: container, breadcrumbs, subcategories first then topics", async () => {
  const h = harness(adapterForum({ topics: 3 }));
  const result = await browse(h, { containerId: "category:10" });
  assert.deepEqual(result.container, {
    id: "category:10",
    kind: "category",
    name: "General",
    detail: null,
  });
  assert.deepEqual(result.breadcrumbs, []);
  assert.deepEqual(
    result.entries.map((entry) => [entry.kind, entry.id]),
    [
      ["category", "category:11"],
      ["topic", "topic:1"],
      ["topic", "topic:2"],
      ["topic", "topic:3"],
      ["topic", "topic:901"],
    ],
  );
  const topic = result.entries[1]!;
  assert.equal(topic.name, "Topic 1");
  assert.equal(topic.selectable, true);
  assert.equal(topic.expandable, false);
  assert.equal(topic.disabledReason, null);
  assert.equal(topic.detail, "2026-01-01 · 2 posts");
  assert.equal(topic.modifiedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(result.hasMore, false);
  assert.equal(result.cursor, "");

  const child = await browse(h, { containerId: "category:11" });
  assert.deepEqual(child.breadcrumbs, [{ id: "category:10", name: "General" }]);
  assert.equal(child.container!.name, "support");
  assert.deepEqual(
    child.entries.map((entry) => entry.id),
    ["topic:901"],
  );
  assert.equal(h.closed(), h.opened());
});

test("browse pages topics 30 at a time with an opaque cursor", async () => {
  const h = harness(adapterForum({ topics: 70 }));
  const first = await browse(h, { containerId: "category:13" });
  assert.equal(first.entries.length, 0);

  const big = harness(adapterForum({ topics: 70 }));
  const one = await browse(big, { containerId: "category:10" });
  // 1 subcategory + 30 topics
  assert.equal(one.entries.length, 31);
  assert.equal(one.entries.filter((e) => e.kind === "topic").length, 30);
  assert.equal(one.hasMore, true);
  assert.deepEqual(
    JSON.parse(Buffer.from(one.cursor, "base64url").toString("utf8")),
    { p: 1 },
  );
  const two = await browse(big, {
    containerId: "category:10",
    cursor: one.cursor,
  });
  // later pages hold topics only
  assert.equal(two.entries.length, 30);
  assert.ok(two.entries.every((e) => e.kind === "topic"));
  assert.equal(two.hasMore, true);
  const three = await browse(big, {
    containerId: "category:10",
    cursor: two.cursor,
  });
  assert.equal(three.entries.length, 11);
  assert.equal(three.hasMore, false);
  assert.equal(three.cursor, "");
  // no topic repeats across pages
  const ids = [...one.entries, ...two.entries, ...three.entries]
    .filter((e) => e.kind === "topic")
    .map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 71);
  // and the page number reached the forum 0-based
  assert.deepEqual(
    big.fake.requests
      .filter((r) => r.path === "/c/10.json")
      .map((r) => r.query.page),
    ["0", "1", "2"],
  );
});

test("browse hides hidden topics and topics of restricted categories", async () => {
  const forum = adapterForum({ topics: 1 });
  forum.topics.push(fakeTopic(50, { visible: false }));
  forum.topics.push(fakeTopic(51, { category_id: 12 }));
  const h = harness(forum);
  const result = await browse(h, { containerId: "category:10" });
  assert.deepEqual(
    result.entries.filter((e) => e.kind === "topic").map((e) => e.id),
    ["topic:1", "topic:901"],
  );
});

test("browse of a restricted, unknown or non-category container is an invalid request", async () => {
  const h = harness(adapterForum());
  for (const request of [
    { containerId: "category:12" },
    { containerId: "category:14" },
    { containerId: "category:999" },
    { containerId: "topic:1" },
    { containerId: "10" },
    { containerId: "category:0" },
    { containerId: "category:012" },
    { containerId: 10 },
    { containerId: "" },
  ]) {
    await assert.rejects(() => browse(h, request), isInvalidRequest);
  }
  assert.equal(h.closed(), h.opened());
});

test("browse of a category the forum refuses (403) is an invalid request", async () => {
  const forum = adapterForum();
  forum.categories = forum.categories.map((c) =>
    c.id === 10 ? { ...c, restricted: true } : c,
  );
  const h = harness(forum);
  await assert.rejects(
    () => browse(h, { containerId: "category:10" }),
    isInvalidRequest,
  );
});

test("browse rejects a foreign or malformed cursor", async () => {
  const h = harness(adapterForum({ topics: 70 }));
  const b64 = (text: string) => Buffer.from(text).toString("base64url");
  for (const cursor of [
    5,
    "not-base64-json!",
    b64("{}"),
    b64('{"p":0}'),
    b64('{"p":-1}'),
    b64('{"p":1.5}'),
    b64('{"p":"1"}'),
    b64('{"p":1,"x":2}'),
    b64('{"o":1}'),
    b64('{"p":100001}'),
    b64("[1]"),
    b64("null"),
    Buffer.from('{"p":1}').toString("base64") + "=",
    "A".repeat(4097),
  ]) {
    await assert.rejects(
      () => browse(h, { containerId: "category:10", cursor }),
      isInvalidRequest,
      JSON.stringify(cursor),
    );
  }
  // a well-formed cursor cannot continue the root listing
  await assert.rejects(
    () => browse(h, { cursor: cursorOf(1) }),
    isInvalidRequest,
  );
  // an empty cursor is no cursor
  assert.equal((await browse(h, { cursor: "" })).entries.length, 4);
});

test("browse paging past the end of a category returns an empty last page", async () => {
  const h = harness(adapterForum({ topics: 3 }));
  const result = await browse(h, {
    containerId: "category:10",
    cursor: cursorOf(5),
  });
  assert.deepEqual(result.entries, []);
  assert.equal(result.hasMore, false);
  assert.equal(result.cursor, "");
});

// ---- search -----------------------------------------------------------------

test("search returns topic entries, deduplicated, restricted categories excluded", async () => {
  const forum = adapterForum({ topics: 3 });
  // topic 900 (restricted category) and 902 (hidden) mention the word too.
  forum.topics = forum.topics.map((t) => ({
    ...t,
    posts: t.posts.map((p) => ({ ...p, cooked: `<p>needle ${t.id}</p>` })),
  }));
  forum.topics.push(fakeTopic(902, { visible: false, title: "needle hidden" }));
  const h = harness(forum);
  const result = await search(h, { query: "  needle  " });
  assert.deepEqual(result.entries.map((e) => e.id).sort(), [
    "topic:1",
    "topic:2",
    "topic:3",
    "topic:901",
  ]);
  for (const entry of result.entries) {
    assert.equal(entry.kind, "topic");
    assert.equal(entry.selectable, true);
    assert.equal(entry.expandable, false);
  }
  assert.equal(result.hasMore, false);
  assert.equal(result.cursor, "");
  const request = h.fake.requests.find((r) => r.path === "/search.json")!;
  assert.equal(request.query.q, "needle");
  assert.equal(request.query.page, "1");
  assert.equal(h.closed(), h.opened());
});

test("search caps at 50 unique topics", async () => {
  const forum = adapterForum({ topics: 80 });
  forum.topics = forum.topics.map((t) => ({
    ...t,
    posts: t.posts.map((p) => ({ ...p, cooked: "<p>needle</p>" })),
  }));
  const h = harness(forum);
  const result = await search(h, { query: "needle" });
  assert.equal(result.entries.length, 50);
  assert.equal(new Set(result.entries.map((e) => e.id)).size, 50);
});

test("search with no match returns no entries", async () => {
  const h = harness(adapterForum());
  const result = await search(h, { query: "zzzz-nothing" });
  assert.deepEqual(result.entries, []);
});

test("search validates the query and the cursor", async () => {
  const h = harness(adapterForum());
  assert.equal((await search(h, { query: "x".repeat(200) })).entries.length, 0);
  assert.equal(
    (await search(h, { query: ` ${"x".repeat(200)} ` })).entries.length,
    0,
  );
  for (const request of [
    {},
    { query: "" },
    { query: "   " },
    { query: "x".repeat(201) },
    { query: 5 },
    { query: "ok", cursor: 5 },
    { query: "ok", cursor: "A".repeat(4097) },
    { query: "ok", cursor: cursorOf(2) },
  ]) {
    await assert.rejects(() => search(h, request), isInvalidRequest);
  }
  assert.equal(h.closed(), h.opened());
});

// ---- describe ---------------------------------------------------------------

test("describe answers every id in request order, duplicates twice, kind from the prefix", async () => {
  const h = harness(adapterForum({ topics: 3 }));
  const ids = [
    "topic:2",
    "category:10",
    "topic:2",
    "category:11",
    "topic:999",
    "category:999",
    "category:12",
    "topic:900",
    "topic:901",
    "category:14",
  ];
  const result = await describe(h, { ids });
  assert.deepEqual(
    result.items.map((i) => i.id),
    ids,
  );
  const [t2, c10, t2again, c11, t999, c999, c12, t900, t901, c14] =
    result.items;
  assert.deepEqual(t2, {
    id: "topic:2",
    kind: "topic",
    name: "Topic 2",
    detail: "General",
    exists: true,
    meta: {},
  });
  assert.deepEqual(t2again, t2);
  assert.deepEqual(c10, {
    id: "category:10",
    kind: "category",
    name: "General",
    detail: "General",
    exists: true,
    meta: {},
  });
  assert.equal(c11!.detail, "General / support");
  assert.equal(t901!.detail, "General / support");
  for (const missing of [t999, c999, c12, t900, c14]) {
    assert.equal(missing!.exists, false, missing!.id);
    assert.equal(missing!.name, null);
    assert.equal(missing!.detail, null);
  }
  assert.equal(t999!.kind, "topic");
  assert.equal(c999!.kind, "category");
  // topic 2 is read once although asked twice
  assert.equal(h.fake.requests.filter((r) => r.path === "/t/2.json").length, 1);
  assert.equal(h.closed(), h.opened());
});

test("describe keeps a category and a topic with the same number apart", async () => {
  const h = harness(adapterForum({ topics: 3 }));
  const result = await describe(h, { ids: ["category:10", "topic:10"] });
  assert.equal(result.items[0]!.name, "General");
  assert.equal(result.items[0]!.exists, true);
  // there is no topic 10
  assert.equal(result.items[1]!.exists, false);
  assert.equal(result.items[1]!.kind, "topic");

  const same = harness(adapterForum({ topics: 3 }));
  const both = await describe(same, { ids: ["category:1", "topic:1"] });
  assert.equal(both.items[0]!.exists, false);
  assert.equal(both.items[1]!.name, "Topic 1");
});

test("describe treats deleted, private and hidden topics as missing", async () => {
  const forum = adapterForum({ topics: 1 });
  forum.topics.push(fakeTopic(60, { gone: true }));
  forum.topics.push(fakeTopic(61, { restricted: true }));
  forum.topics.push(fakeTopic(62, { visible: false }));
  const h = harness(forum);
  const result = await describe(h, {
    ids: ["topic:60", "topic:61", "topic:62"],
  });
  assert.deepEqual(
    result.items.map((i) => i.exists),
    [false, false, false],
  );
});

test("describe accepts 1 and 100 ids and rejects 0, 101 and malformed ids", async () => {
  const h = harness(adapterForum());
  assert.equal((await describe(h, { ids: ["category:10"] })).items.length, 1);
  const hundred = Array.from({ length: 100 }, (_, i) => `category:${i + 1}`);
  assert.equal((await describe(h, { ids: hundred })).items.length, 100);
  for (const request of [
    { ids: [] },
    { ids: [...hundred, "category:101"] },
    {},
    { ids: "category:10" },
    { ids: ["10"] },
    { ids: ["forum:10"] },
    { ids: ["category:0"] },
    { ids: ["category:10x"] },
    { ids: [10] },
    { ids: ["category:10", null] },
  ]) {
    await assert.rejects(() => describe(h, request), isInvalidRequest);
  }
});

test("describe of 100 topics reads one topic document each and stays bounded", async () => {
  const forum = adapterForum({ topics: 100 });
  const h = harness(forum);
  const ids = Array.from({ length: 100 }, (_, i) => `topic:${i + 1}`);
  const result = await describe(h, { ids });
  assert.ok(result.items.every((i) => i.exists));
  // site.json plus one document per topic
  assert.equal(h.fake.requests.length, 101);
});

// ---- scope and budget -------------------------------------------------------

test("a selection action closes its scope on failure and on invalid input", async () => {
  const h = harness({ ...adapterForum(), loginRequired: true });
  await assert.rejects(
    () => browse(h),
    (error: unknown) =>
      error instanceof DiscourseAdapterError &&
      error.code === "DISCOURSE_LOGIN_REQUIRED",
  );
  assert.equal(h.opened(), 1);
  assert.equal(h.closed(), 1);
  await assert.rejects(() => describe(h, { ids: [] }), isInvalidRequest);
  assert.equal(h.closed(), h.opened());
});

test("an action does not use the connector's items, only its forum address", async () => {
  const h = harness(adapterForum());
  const result = await h.adapter.executeAction({
    ...baseInput({ forumUrl: "https://forum.example.com/" }),
    actionType: "discourse.browse",
    request: {},
    idempotencyKey: "k",
  });
  assert.ok(connectorSelectionBrowseResultSchema.parse(result.result));
  await assert.rejects(
    () =>
      h.adapter.executeAction({
        ...baseInput({ forumUrl: "http://forum.example.com" }),
        actionType: "discourse.browse",
        request: {},
        idempotencyKey: "k",
      }),
    (error: unknown) =>
      error instanceof DiscourseAdapterError &&
      error.code === "DISCOURSE_CONFIG_INVALID",
  );
});

test("a scan after 1,500 browse requests still has a full request budget", async () => {
  const h = harness(adapterForum({ topics: 2 }));
  for (let i = 0; i < 1500; i += 1) await browse(h);
  assert.equal(h.opened(), 1500);
  assert.equal(h.closed(), 1500);
  const pages = [];
  for await (const page of h.adapter.discoverPages!({
    ...baseInput(forumConfig([{ id: "category:10", kind: "category" }])),
  })) {
    pages.push(page);
  }
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.reconcileMissing, true);
  assert.equal(pages[0]!.items.length, 3);
});

test("a describe or search call after many calls is not starved either", async () => {
  const h = harness(adapterForum({ topics: 2 }), {
    limits: { maxRequests: 3 },
  });
  for (let i = 0; i < 8; i += 1) {
    await describe(h, { ids: ["topic:1", "topic:2"] });
    await search(h, { query: "Hello" });
  }
  assert.equal(h.opened(), 16);
});

test("browse of 600 top-level categories stays within the platform's 500-entry bound", async () => {
  const categories = Array.from({ length: 600 }, (_, i) => ({
    id: i + 1,
    name: `Cat ${String(i).padStart(4, "0")}`,
    slug: `cat-${i}`,
  }));
  const h = harness(adapterForum({ categories }));
  const result = await browse(h);
  assert.equal(result.entries.length, 500);
  assert.equal(result.entries[0]!.name, "Cat 0000");
  assert.equal(result.entries[499]!.name, "Cat 0499");
  assert.equal(result.hasMore, false);
  assert.equal(result.cursor, "");
});

test("browse of a category with 600 subcategories stays within the bound", async () => {
  const categories = [
    { id: 1, name: "Parent", slug: "parent" },
    ...Array.from({ length: 600 }, (_, i) => ({
      id: i + 2,
      name: `Sub ${String(i).padStart(4, "0")}`,
      slug: `sub-${i}`,
      parent_category_id: 1,
    })),
  ];
  const h = harness(adapterForum({ categories }));
  const result = await browse(h, { containerId: "category:1" });
  assert.ok(result.entries.length <= 500);
  assert.equal(
    result.entries.filter((entry) => entry.kind === "category").length,
    450,
  );
});

// ---- wall-clock bound -------------------------------------------------------

/** A fetch that never answers and ignores the abort signal. */
function stalledHarness(deadlineMs: number) {
  let opened = 0;
  let closed = 0;
  const adapter = createDiscourseAdapter({
    publicFetch: () => {
      opened += 1;
      return {
        fetch: (() => new Promise<Response>(() => {})) as typeof fetch,
        close: async () => {
          closed += 1;
        },
      };
    },
    limits: { minRequestGapMs: 0, ACTION_DEADLINE_MS: deadlineMs },
  });
  return { adapter, opened: () => opened, closed: () => closed };
}

test("a stalled forum ends a browse, search or describe in DISCOURSE_FORUM_UNREACHABLE and closes the scope", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const [actionType, request] of [
      ["discourse.browse", {}],
      ["discourse.search", { query: "x" }],
      ["discourse.describe", { ids: ["topic:1"] }],
    ] as const) {
      const h = stalledHarness(30);
      const started = Date.now();
      await assert.rejects(
        () =>
          h.adapter.executeAction({
            ...baseInput(forumConfig([])),
            actionType,
            request,
            idempotencyKey: "k",
          }),
        (error: unknown) =>
          error instanceof DiscourseAdapterError &&
          error.code === "DISCOURSE_FORUM_UNREACHABLE" &&
          error.statusCode === 502,
        actionType,
      );
      assert.ok(Date.now() - started < 5000);
      assert.equal(h.opened(), 1);
      assert.equal(h.closed(), 1);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a stalled forum makes readiness forum_unreachable and closes the scope", async () => {
  const h = stalledHarness(30);
  const result = await h.adapter.checkSyncReadiness!(
    baseInput(forumConfig([{ id: "topic:1", kind: "topic" }])),
  );
  assert.equal(result.ready, false);
  assert.equal(result.reason, "forum_unreachable");
  assert.equal(h.opened(), 1);
  assert.equal(h.closed(), 1);
});

test("the action deadline does not cut off a quick call and leaves no timer behind", async () => {
  const h = harness(adapterForum(), { limits: { ACTION_DEADLINE_MS: 60_000 } });
  assert.equal((await browse(h)).entries.length, 4);
  // A pending 60 s timer would keep this test process alive past the run;
  // the suite finishing proves the timer was cleared.
});
