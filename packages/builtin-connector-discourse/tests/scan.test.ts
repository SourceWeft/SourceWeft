import assert from "node:assert/strict";
import test from "node:test";
import { createDiscourseClient } from "../src/client";
import { DiscourseError } from "../src/errors";
import { POST_BATCH } from "../src/limits";
import {
  deepHashOf,
  lightHashOf,
  parsePost,
  parseTopic,
  type DiscoursePost,
} from "../src/model";
import { scanForum } from "../src/scan";
import {
  FAKE_PAGE_SIZE,
  startFakeDiscourse,
  type FakeCategory,
  type FakeForum,
  type FakePost,
  type FakeTopic,
} from "./helpers/fake-discourse";

const BASE = "https://forum.example.com";

function posts(topicId: number, count: number): FakePost[] {
  return Array.from({ length: count }, (_, i) => ({
    id: topicId * 1000 + i + 1,
    post_number: i + 1,
    username: i % 2 === 0 ? "alice" : "bob",
    cooked: `<p>Post ${i + 1} of topic ${topicId}</p>`,
  }));
}

function topic(
  id: number,
  category: number,
  options: Partial<FakeTopic> & { postCount?: number } = {},
): FakeTopic {
  const { postCount, ...rest } = options;
  return {
    id,
    title: `Topic ${id}`,
    slug: `topic-${id}`,
    category_id: category,
    posts: posts(id, postCount ?? 2),
    ...rest,
  };
}

const CATEGORIES: FakeCategory[] = [
  { id: 10, name: "General", slug: "general" },
  { id: 11, name: "Support", slug: "support", parent_category_id: 10 },
  { id: 12, name: "Staff", slug: "staff", read_restricted: true },
  { id: 13, name: "Other", slug: "other" },
  { id: 20, name: "Private", slug: "private", read_restricted: true },
  { id: 21, name: "Inside", slug: "inside", parent_category_id: 20 },
  {
    id: 14,
    name: "Secret child",
    slug: "secret",
    parent_category_id: 10,
    read_restricted: true,
  },
];

function forum(topics: FakeTopic[], categories = CATEGORIES): FakeForum {
  return { categories, topics };
}

type Sel = Array<{ id: number; kind: "category" | "topic" }>;
const cat = (...ids: number[]): Sel =>
  ids.map((id) => ({ id, kind: "category" }));
const top = (...ids: number[]): Sel => ids.map((id) => ({ id, kind: "topic" }));

function setup(
  initial: FakeForum,
  options: {
    wrap?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch;
    clientLimits?: Parameters<typeof createDiscourseClient>[0]["limits"];
  } = {},
) {
  const fake = startFakeDiscourse(initial);
  const client = createDiscourseClient({
    fetch: options.wrap ? options.wrap(fake.fetch) : fake.fetch,
    base: BASE,
    sleep: async () => undefined,
    limits: { minRequestGapMs: 0, ...options.clientLimits },
  });
  return { fake, client };
}

type Scan = Parameters<typeof scanForum>[0];

async function run(
  client: Scan["client"],
  selection: Sel,
  extra: Partial<Omit<Scan, "client" | "selection">> = {},
) {
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> =
    [];
  const pages = [];
  for await (const page of scanForum({
    client,
    base: BASE,
    selection,
    refresh: "light",
    now: () => 1_000,
    logger: {
      warn: (message, meta) => {
        warnings.push({ message, meta });
      },
    },
    ...extra,
  })) {
    pages.push(page);
  }
  return { pages, warnings };
}

async function only(
  client: Scan["client"],
  selection: Sel,
  extra: Partial<Omit<Scan, "client" | "selection">> = {},
) {
  const { pages, warnings } = await run(client, selection, extra);
  assert.equal(pages.length, 1);
  const [page] = pages;
  assert.ok(page);
  return { page, warnings };
}

const ids = (page: { items: { externalId: string }[] }) =>
  page.items.map((i) => i.externalId).sort();

const paths = (fake: { requests: { path: string }[] }) =>
  fake.requests.map((r) => r.path);

const INCOMPLETE = {
  items: [],
  deletedExternalIds: [],
  complete: true,
  reconcileMissing: false,
  checkpoint: null,
};

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DiscourseError, "a DiscourseError");
    assert.equal(error.code, code);
    return true;
  });
}

/** Rewrites the JSON body of every `c/<id>.json` response. */
function rewriteCategory(
  change: (body: any, url: URL) => unknown,
): (inner: typeof fetch) => typeof fetch {
  return (inner) =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await inner(input, init);
      const url = new URL(String(input));
      if (!/\/c\/\d+\.json$/.test(url.pathname) || response.status !== 200) {
        return response;
      }
      const body = change(await response.json(), url);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
}

// ---------------------------------------------------------------- selection

test("an empty selection throws DISCOURSE_SELECTION_REQUIRED before any request", async () => {
  const { fake, client } = setup(forum([topic(1, 10)]));
  await rejectsWith(run(client, []), "DISCOURSE_SELECTION_REQUIRED");
  assert.equal(fake.requests.length, 0);
});

test("a category scan yields one complete page that includes its subcategory", async () => {
  const { fake, client } = setup(
    forum([topic(1, 10), topic(2, 11), topic(3, 13)]),
  );
  const { page, warnings } = await only(client, cat(10));
  assert.deepEqual(ids(page), ["discourse:topic:1", "discourse:topic:2"]);
  assert.equal(page.complete, true);
  assert.equal(page.reconcileMissing, true);
  assert.deepEqual(page.deletedExternalIds, []);
  assert.equal(page.checkpoint, null);
  assert.deepEqual(warnings, []);
  const child = page.items.find((i) => i.externalId === "discourse:topic:2");
  assert.equal(child?.metadata.categoryPath, "General / Support");
  assert.equal(child?.metadata.categoryId, 11);
  assert.equal(child?.mimeType, "text/markdown");
  assert.deepEqual(paths(fake), ["/site.json", "/c/10.json"]);
});

test("a selected parent and child category are walked once, through the parent", async () => {
  const { fake, client } = setup(forum([topic(1, 10), topic(2, 11)]));
  const { page } = await only(client, cat(11, 10));
  assert.deepEqual(ids(page), ["discourse:topic:1", "discourse:topic:2"]);
  assert.deepEqual(paths(fake), ["/site.json", "/c/10.json"]);
});

test("a selected child category alone is walked on its own", async () => {
  const { fake, client } = setup(forum([topic(1, 10), topic(2, 11)]));
  const { page } = await only(client, cat(11));
  assert.deepEqual(ids(page), ["discourse:topic:2"]);
  assert.deepEqual(paths(fake), ["/site.json", "/c/11.json"]);
});

test("a category cycle still walks each reachable category once", async () => {
  const cycle: FakeCategory[] = [
    { id: 30, name: "A", slug: "a", parent_category_id: 31 },
    { id: 31, name: "B", slug: "b", parent_category_id: 30 },
  ];
  const { fake, client } = setup(forum([], cycle));
  const { page } = await only(client, cat(30, 31));
  assert.equal(page.reconcileMissing, true);
  assert.equal(paths(fake).filter((p) => p.startsWith("/c/")).length, 1);
});

test("a single topic already covered by a selected category is emitted once, without its own request", async () => {
  const { fake, client } = setup(forum([topic(1, 10), topic(2, 10)]));
  const { page } = await only(client, [...top(1), ...cat(10), ...top(2)]);
  assert.deepEqual(ids(page), ["discourse:topic:1", "discourse:topic:2"]);
  assert.deepEqual(paths(fake), ["/site.json", "/c/10.json"]);
});

test("the same selection twice is read once", async () => {
  const { fake, client } = setup(forum([topic(1, 10), topic(5, 13)]));
  const { page } = await only(client, [...cat(10, 10), ...top(5, 5)]);
  assert.deepEqual(ids(page), ["discourse:topic:1", "discourse:topic:5"]);
  assert.deepEqual(paths(fake), ["/site.json", "/c/10.json", "/t/5.json"]);
});

test("a single topic is read through topic() and indexed from its own row", async () => {
  const { fake, client } = setup(forum([topic(5, 13, { tags: ["x"] })]));
  const { page } = await only(client, top(5));
  assert.equal(page.reconcileMissing, true);
  assert.equal(page.items.length, 1);
  assert.deepEqual(paths(fake), ["/site.json", "/t/5.json"]);
  const doc = await (await fake.fetch(`${BASE}/t/5.json`)).json();
  const row = parseTopic(doc, 5);
  assert.equal(page.items[0]?.contentHash, lightHashOf(row));
  assert.equal(page.items[0]?.metadata.categoryPath, "Other");
});

// ------------------------------------------------------- vanished / hidden

test("a deleted selected topic and a vanished category give a complete, reconciling, empty page", async () => {
  const { client } = setup(forum([topic(7, 13, { gone: true }), topic(8, 13)]));
  const { page } = await only(client, [...top(7), ...cat(999)]);
  assert.deepEqual(page.items, []);
  assert.equal(page.complete, true);
  assert.equal(page.reconcileMissing, true);
});

test("a topic that is missing (404) is simply absent", async () => {
  const { client } = setup(forum([topic(8, 13)]));
  const { page } = await only(client, top(404, 8));
  assert.deepEqual(ids(page), ["discourse:topic:8"]);
  assert.equal(page.reconcileMissing, true);
});

test("a selected category the forum answers invalid_access for contributes nothing and still reconciles", async () => {
  const cats: FakeCategory[] = [
    ...CATEGORIES,
    { id: 40, name: "Hidden", slug: "hidden", restricted: true },
  ];
  const { fake, client } = setup(forum([topic(1, 10)], cats));
  const { page } = await only(client, cat(40));
  assert.deepEqual(page.items, []);
  assert.equal(page.reconcileMissing, true);
  assert.deepEqual(paths(fake), ["/site.json", "/c/40.json"]);
});

test("a read-restricted selected category is never requested", async () => {
  const { fake, client } = setup(forum([topic(1, 12)]));
  const { page } = await only(client, cat(12));
  assert.deepEqual(page.items, []);
  assert.equal(page.reconcileMissing, true);
  assert.deepEqual(paths(fake), ["/site.json"]);
});

test("a child of a restricted parent is restricted and never requested", async () => {
  const { fake, client } = setup(forum([topic(1, 21)]));
  const { page } = await only(client, cat(21));
  assert.deepEqual(page.items, []);
  assert.equal(page.reconcileMissing, true);
  assert.deepEqual(paths(fake), ["/site.json"]);
});

test("topics of a restricted subcategory, invisible topics and unknown categories are dropped", async () => {
  const { client } = setup(
    forum([
      topic(1, 10),
      topic(2, 14),
      topic(3, 10, { visible: false }),
      topic(4, 99),
    ]),
  );
  const listed = await only(client, cat(10));
  assert.deepEqual(ids(listed.page), ["discourse:topic:1"]);
  const single = await only(client, top(2, 3, 4, 1));
  assert.deepEqual(ids(single.page), ["discourse:topic:1"]);
  assert.equal(single.page.reconcileMissing, true);
});

test("a topic restricted to the reader after being listed is dropped in deep mode", async () => {
  const { client } = setup(
    forum([topic(1, 10), topic(2, 10, { restricted: true })]),
  );
  const { page } = await only(client, cat(10), { refresh: "deep" });
  assert.deepEqual(ids(page), ["discourse:topic:1"]);
  assert.equal(page.reconcileMissing, true);
});

// ------------------------------------------------------------ light / deep

test("light does not request topics listed by a category; deep does", async () => {
  const f = forum([topic(1, 10), topic(2, 10)]);
  const light = setup(f);
  await only(light.client, cat(10));
  assert.deepEqual(paths(light.fake), ["/site.json", "/c/10.json"]);

  const deep = setup(f);
  const { page } = await only(deep.client, cat(10), { refresh: "deep" });
  assert.equal(page.items.length, 2);
  assert.deepEqual(paths(deep.fake), [
    "/site.json",
    "/c/10.json",
    "/t/1.json",
    "/t/2.json",
  ]);
});

test("a deep hash is deepHashOf over the visible posts that were read", async () => {
  const f = forum([
    topic(1, 10, {
      postCount: 3,
    }),
  ]);
  f.topics[0]?.posts.push({
    id: 1900,
    post_number: 4,
    username: "mod",
    cooked: "<p>whisper</p>",
    post_type: 4,
  });
  const { fake, client } = setup(f);
  const { page } = await only(client, cat(10), { refresh: "deep" });
  const doc = await (await fake.fetch(`${BASE}/t/1.json`)).json();
  const row = parseTopic(doc, 1);
  assert.equal(page.items[0]?.contentHash, deepHashOf(row, row.posts));
  assert.notEqual(page.items[0]?.contentHash, lightHashOf(row));
  assert.deepEqual(page.items[0]?.metadata.postIds, [1001, 1002, 1003]);
  assert.deepEqual(page.items[0]?.metadata.authors, ["alice", "bob"]);
  assert.equal("omittedPosts" in (page.items[0]?.metadata ?? {}), false);
});

test("an edit with no reply leaves the light hash and changes the deep hash", async () => {
  const f = forum([topic(1, 10)]);
  const a = setup(f);
  const light1 = await only(a.client, cat(10));
  const deep1 = await only(a.client, cat(10), { refresh: "deep" });
  const edited = forum([topic(1, 10)]);
  const firstPost = edited.topics[0]?.posts[0] as FakePost;
  firstPost.version = 2;
  firstPost.updated_at = "2026-02-02T00:00:00.000Z";
  a.fake.setForum(edited);
  const light2 = await only(a.client, cat(10));
  const deep2 = await only(a.client, cat(10), { refresh: "deep" });
  assert.equal(
    light1.page.items[0]?.contentHash,
    light2.page.items[0]?.contentHash,
  );
  assert.notEqual(
    deep1.page.items[0]?.contentHash,
    deep2.page.items[0]?.contentHash,
  );
  assert.notEqual(
    light1.page.items[0]?.contentHash,
    deep1.page.items[0]?.contentHash,
  );
});

test("a deep scan fetches the posts beyond the first page in batches", async () => {
  const { fake, client } = setup(forum([topic(1, 10, { postCount: 65 })]));
  const { page } = await only(client, cat(10), { refresh: "deep" });
  const batches = fake.requests.filter((r) => r.path === "/t/1/posts.json");
  assert.deepEqual(
    batches.map((r) => r.queryAll["post_ids[]"]?.length),
    [POST_BATCH, POST_BATCH, 5],
  );
  const asked = batches.flatMap((r) => r.queryAll["post_ids[]"] ?? []);
  assert.equal(new Set(asked).size, 45);
  assert.equal(
    asked.includes("1001"),
    false,
    "posts of the first page are not re-read",
  );
  assert.equal((page.items[0]?.metadata.postIds as number[]).length, 65);
  assert.equal("omittedPosts" in (page.items[0]?.metadata ?? {}), false);
});

test("a topic over the post cap is hashed over what was read and records the omitted count", async () => {
  const { fake, client } = setup(forum([topic(1, 10, { postCount: 65 })]));
  const { page } = await only(client, cat(10), {
    refresh: "deep",
    limits: { MAX_POSTS_PER_TOPIC: 25 },
  });
  const item = page.items[0];
  assert.equal(item?.metadata.omittedPosts, 40);
  assert.equal((item?.metadata.postIds as number[]).length, 25);
  const batches = fake.requests.filter((r) => r.path === "/t/1/posts.json");
  assert.deepEqual(
    batches.map((r) => r.queryAll["post_ids[]"]?.length),
    [5],
  );
  // The hash is over exactly the indexed posts.
  const doc = parseTopic(
    await (await fake.fetch(`${BASE}/t/1.json`)).json(),
    1,
  );
  const raw = (await (
    await fake.fetch(
      `${BASE}/t/1/posts.json?post_ids[]=${[1021, 1022, 1023, 1024, 1025].join("&post_ids[]=")}`,
    )
  ).json()) as { post_stream: { posts: unknown[] } };
  const read: DiscoursePost[] = [
    ...doc.posts,
    ...raw.post_stream.posts.map(parsePost),
  ];
  assert.equal(item?.contentHash, deepHashOf(doc, read));
});

test("a topic whose posts vanish mid-scan is dropped in deep mode", async () => {
  const f = forum([topic(1, 10, { postCount: 30 })]);
  const { fake, client } = setup(f);
  fake.failNext(
    { status: 410, body: "" },
    1,
    (r) => r.path === "/t/1/posts.json",
  );
  const { page } = await only(client, cat(10), { refresh: "deep" });
  assert.deepEqual(page.items, []);
  assert.equal(page.reconcileMissing, true);
});

test("a single selected topic is requested once in deep mode", async () => {
  const { fake, client } = setup(forum([topic(5, 13)]));
  const { page } = await only(client, top(5), { refresh: "deep" });
  assert.equal(page.items.length, 1);
  assert.deepEqual(paths(fake), ["/site.json", "/t/5.json"]);
});

// ------------------------------------------------------------- pagination

test("a light scan makes one site request plus one request per page", async () => {
  const total = FAKE_PAGE_SIZE * 2 + 5;
  const topics = Array.from({ length: total }, (_, i) => topic(i + 1, 10));
  const { fake, client } = setup(forum(topics));
  const { page } = await only(client, cat(10));
  assert.equal(page.items.length, total);
  assert.equal(fake.requests.length, 1 + 3);
  assert.deepEqual(
    fake.requests.slice(1).map((r) => r.query.page),
    ["0", "1", "2"],
  );
});

test("pagination ends on an empty page even if more_topics_url keeps lying", async () => {
  const topics = Array.from({ length: 35 }, (_, i) => topic(i + 1, 10));
  const { fake, client } = setup(forum(topics), {
    wrap: rewriteCategory((body) => {
      body.topic_list.more_topics_url = "/c/10/l/latest?page=99";
      return body;
    }),
  });
  const { page } = await only(client, cat(10));
  assert.equal(page.items.length, 35);
  assert.equal(page.reconcileMissing, true);
  // site + page 0, 1 and the empty page 2: never a URL from the response.
  assert.deepEqual(
    fake.requests.map((r) => `${r.path}?${r.query.page ?? ""}`),
    ["/site.json?", "/c/10.json?0", "/c/10.json?1", "/c/10.json?2"],
  );
});

test("a page without topics ends the walk even when it claims more", async () => {
  const { fake, client } = setup(forum([]), {
    wrap: rewriteCategory((body) => {
      body.topic_list.more_topics_url = "/x";
      return body;
    }),
  });
  const { page } = await only(client, cat(10));
  assert.deepEqual(page.items, []);
  assert.equal(page.reconcileMissing, true);
  assert.equal(fake.requests.length, 2);
});

test("duplicate topic rows are emitted once", async () => {
  const { client } = setup(forum([topic(1, 10), topic(2, 10)]), {
    wrap: rewriteCategory((body) => {
      body.topic_list.topics.push({ ...body.topic_list.topics[0] });
      return body;
    }),
  });
  const { page } = await only(client, cat(10));
  assert.deepEqual(ids(page), ["discourse:topic:1", "discourse:topic:2"]);
});

test("a category that vanishes mid-walk contributes nothing", async () => {
  const topics = Array.from({ length: 40 }, (_, i) => topic(i + 1, 10));
  const { fake, client } = setup(forum(topics));
  fake.failNext(
    { status: 404, body: "" },
    1,
    (r) => r.path === "/c/10.json" && r.query.page === "1",
  );
  const { page } = await only(client, cat(10));
  assert.deepEqual(page.items, []);
  assert.equal(page.reconcileMissing, true);
});

// ------------------------------------------------------------------ caps

test("a request cap yields the incomplete result with the fixed warning", async () => {
  const topics = Array.from({ length: 70 }, (_, i) => topic(i + 1, 10));
  const { client } = setup(forum(topics));
  const { page, warnings } = await only(client, cat(10), {
    limits: { MAX_REQUESTS: 2 },
  });
  assert.deepEqual(page, INCOMPLETE);
  assert.deepEqual(warnings, [
    { message: "discourse_scan_incomplete", meta: { reason: "too_large" } },
  ]);
});

test("the client's own request ceiling yields the incomplete result", async () => {
  const topics = Array.from({ length: 70 }, (_, i) => topic(i + 1, 10));
  const { client } = setup(forum(topics), { clientLimits: { maxRequests: 2 } });
  const { page, warnings } = await only(client, cat(10));
  assert.deepEqual(page, INCOMPLETE);
  assert.equal(warnings[0]?.meta?.reason, "too_large");
});

test("more topics than MAX_TOPICS yields the incomplete result", async () => {
  const { client } = setup(forum([topic(1, 10), topic(2, 10), topic(3, 10)]));
  const { page, warnings } = await only(client, cat(10), {
    limits: { MAX_TOPICS: 2 },
  });
  assert.deepEqual(page, INCOMPLETE);
  assert.equal(warnings[0]?.meta?.reason, "too_large");
});

test("more topics than MAX_TOPICS counts single topics too", async () => {
  const { client } = setup(forum([topic(1, 10), topic(5, 13), topic(6, 13)]));
  const { page } = await only(client, [...cat(10), ...top(5, 6)], {
    limits: { MAX_TOPICS: 2 },
  });
  assert.deepEqual(page, INCOMPLETE);
});

test("a category longer than MAX_TOPICS_PER_CATEGORY yields the incomplete result", async () => {
  const topics = Array.from({ length: 40 }, (_, i) => topic(i + 1, 10));
  const { client } = setup(forum(topics));
  const { page, warnings } = await only(client, cat(10), {
    limits: { MAX_TOPICS_PER_CATEGORY: 35 },
  });
  assert.deepEqual(page, INCOMPLETE);
  assert.equal(warnings[0]?.meta?.reason, "too_large");
});

test("a category of exactly MAX_TOPICS_PER_CATEGORY topics is complete", async () => {
  const topics = Array.from({ length: 30 }, (_, i) => topic(i + 1, 10));
  const { client } = setup(forum(topics));
  const { page } = await only(client, cat(10), {
    limits: { MAX_TOPICS_PER_CATEGORY: 30 },
  });
  assert.equal(page.items.length, 30);
  assert.equal(page.reconcileMissing, true);
});

test("the wall-clock deadline is checked before every request", async () => {
  const topics = Array.from({ length: 70 }, (_, i) => topic(i + 1, 10));
  const { fake, client } = setup(forum(topics));
  let clock = 1_000;
  const { page, warnings } = await only(client, cat(10), {
    now: () => {
      const value = clock;
      clock += 400;
      return value;
    },
    limits: { SCAN_TIMEOUT_MS: 1_000 },
  });
  assert.deepEqual(page, INCOMPLETE);
  assert.deepEqual(warnings, [
    { message: "discourse_scan_incomplete", meta: { reason: "timeout" } },
  ]);
  assert.ok(fake.requests.length < 3);
});

test("a deadline already passed sends no request at all", async () => {
  const { fake, client } = setup(forum([topic(1, 10)]));
  let calls = 0;
  const { page } = await only(client, cat(10), {
    now: () => (calls++ === 0 ? 0 : 10_000),
    limits: { SCAN_TIMEOUT_MS: 100 },
  });
  assert.deepEqual(page, INCOMPLETE);
  assert.equal(fake.requests.length, 0);
});

test("the warning carries nothing but the fixed event and reason", async () => {
  const { client } = setup(forum([topic(1, 10), topic(2, 10)]));
  const { warnings } = await only(client, cat(10), {
    limits: { MAX_TOPICS: 1 },
  });
  assert.equal(warnings.length, 1);
  assert.deepEqual(Object.keys(warnings[0]?.meta ?? {}), ["reason"]);
  assert.doesNotMatch(JSON.stringify(warnings), /forum\.example|10|Topic/);
});

// ---------------------------------------------------------- fatal errors

test("a rate-limited forum surfaces RATE_LIMITED", async () => {
  const { fake, client } = setup(forum([topic(1, 10)]));
  fake.failNext({ status: 429, body: "{}" }, 10);
  await rejectsWith(run(client, cat(10)), "DISCOURSE_RATE_LIMITED");
});

test("a login-required forum surfaces LOGIN_REQUIRED", async () => {
  const f = forum([topic(1, 10)]);
  f.loginRequired = true;
  const { client } = setup(f);
  await rejectsWith(run(client, cat(10)), "DISCOURSE_LOGIN_REQUIRED");
});

test("a login wall on a category is fatal, not an empty category", async () => {
  const { fake, client } = setup(forum([topic(1, 10)]));
  fake.failNext(
    { status: 403, body: JSON.stringify({ error_type: "not_logged_in" }) },
    1,
    (r) => r.path === "/c/10.json",
  );
  await rejectsWith(run(client, cat(10)), "DISCOURSE_LOGIN_REQUIRED");
});

test("an unreachable forum is fatal, not an empty scan", async () => {
  const { fake, client } = setup(forum([topic(1, 10)]));
  fake.failNext({ status: 500, body: "" }, 1, (r) => r.path === "/t/1.json");
  await rejectsWith(run(client, top(1)), "DISCOURSE_FORUM_UNREACHABLE");
});

test("a malformed list row makes the scan throw BAD_RESPONSE", async () => {
  const { client } = setup(forum([topic(1, 10), topic(2, 10)]), {
    wrap: rewriteCategory((body) => {
      body.topic_list.topics[1] = { id: 2 };
      return body;
    }),
  });
  await rejectsWith(run(client, cat(10)), "DISCOURSE_BAD_RESPONSE");
});

test("a malformed category in site.json makes the scan throw BAD_RESPONSE", async () => {
  const fake = startFakeDiscourse(forum([topic(1, 10)]));
  const client = createDiscourseClient({
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fake.fetch(input, init);
      if (!String(input).endsWith("/site.json")) return response;
      const body = (await response.json()) as { categories: unknown[] };
      body.categories.push({ name: "no id" });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
    base: BASE,
    sleep: async () => undefined,
    limits: { minRequestGapMs: 0 },
  });
  await rejectsWith(run(client, cat(10)), "DISCOURSE_BAD_RESPONSE");
});
