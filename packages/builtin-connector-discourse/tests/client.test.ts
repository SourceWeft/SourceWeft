import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import {
  createDiscourseClient,
  createDiscourseTransport,
  isNotFound,
  type DiscourseClient,
  type DiscourseTransport,
} from "../src/client";
import { DiscourseError, type DiscourseErrorCode } from "../src/errors";
import {
  MAX_REQUESTS,
  MAX_RETRY_DELAY_MS,
  MIN_REQUEST_GAP_MS,
} from "../src/limits";
import {
  FAKE_PAGE_SIZE,
  sampleForum,
  startFakeDiscourse,
  type FakeDiscourse,
  type FakeForum,
} from "./helpers/fake-discourse";

const BASE = "https://forum.example.com";

type Harness = {
  fake: FakeDiscourse;
  client: DiscourseClient;
  /** The raw transport, a second instance over the same fake. */
  transport: DiscourseTransport;
  sleeps: number[];
  clock: { t: number };
};

function harness(
  forum: FakeForum = sampleForum(),
  options: {
    base?: string;
    fetch?: typeof fetch;
    maxResponseBytes?: number;
    requestTimeoutMs?: number;
    signal?: AbortSignal;
    limits?: Parameters<typeof createDiscourseClient>[0]["limits"];
  } = {},
): Harness {
  const fake = startFakeDiscourse(forum);
  const sleeps: number[] = [];
  const clock = { t: 1_000_000 };
  const config = {
    fetch: options.fetch ?? fake.fetch,
    base: options.base ?? BASE + (forum.basePath ?? ""),
    now: () => clock.t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    maxResponseBytes: options.maxResponseBytes,
    requestTimeoutMs: options.requestTimeoutMs,
    signal: options.signal,
    limits: options.limits,
  };
  return {
    fake,
    client: createDiscourseClient(config),
    transport: createDiscourseTransport(config),
    sleeps,
    clock,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<DiscourseErrorCode> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DiscourseError, String(error));
    return error.code;
  }
  assert.fail("expected a DiscourseError");
}

test("requests are GET with Accept and User-Agent only", async () => {
  const { fake, client } = harness();
  await client.site();
  const request = fake.requests[0]!;
  assert.equal(request.method, "GET");
  assert.equal(request.url, `${BASE}/site.json`);
  assert.deepEqual(Object.keys(request.headers).sort(), [
    "accept",
    "user-agent",
  ]);
  assert.equal(request.headers.accept, "application/json");
  assert.match(request.headers["user-agent"] ?? "", /^SourceWeft/);
  assert.deepEqual(request.initKeys.sort(), [
    "headers",
    "method",
    "redirect",
    "signal",
  ]);
});

test("every request asks the host fetch not to follow redirects", async () => {
  // The host's public scope follows cross-origin redirects unless asked not
  // to; with `manual` it refuses a cross-origin hop and hands back a
  // same-origin one for the client to reject.
  const { fake, client } = harness();
  await client.site();
  await client.categoryPage(10, 0);
  await client.topic(1);
  await client.topicPosts(1, [1001]);
  await client.search("hello", 1);
  assert.equal(fake.requests.length, 5);
  assert.ok(fake.requests.every((request) => request.redirect === "manual"));
});

test("a category list follows the forum's own slug redirect (a real forum answers c/<id>.json with a 301)", async () => {
  for (const basePath of [undefined, "/forum"]) {
    const forum = { ...sampleForum({ basePath }), categoryRedirect: true };
    const { fake, client, sleeps } = harness(forum);
    const prefix = basePath ?? "";
    const parent = await client.categoryPage(10, 0);
    assert.ok(!isNotFound(parent));
    assert.equal(parent.topics.length, 3);
    await client.categoryPage(11, 1);
    assert.deepEqual(
      fake.requests.map((r) => `${r.path}?${new URLSearchParams(r.query)}`),
      [
        `${prefix}/c/10.json?page=0`,
        `${prefix}/c/general/10.json?page=0`,
        `${prefix}/c/11.json?page=1`,
        `${prefix}/c/general/support/11.json?page=1`,
      ],
    );
    assert.ok(fake.requests.every((r) => r.redirect === "manual"));
    // Following the redirect is not a retry: only the request gap is waited.
    assert.ok(sleeps.every((ms) => ms <= MIN_REQUEST_GAP_MS), String(sleeps));
  }
});

test("only the slug redirect of a category list is followed; every other redirect is refused", async () => {
  const forum = { ...sampleForum(), categoryRedirect: true };
  const { fake, client } = harness(forum);

  const refused: Array<[string, string]> = [
    ["another origin", "https://other.example.org/c/general/10.json?page=0"],
    ["another host spelling", "https://forum.example.com.evil.example/c/general/10.json?page=0"],
    ["userinfo", "https://u:p@forum.example.com/c/general/10.json?page=0"],
    ["http", "http://forum.example.com/c/general/10.json?page=0"],
    ["another id", "/c/general/11.json?page=0"],
    ["another endpoint", "/site.json?page=0"],
    ["a topic", "/t/1.json?page=0"],
    ["outside /c/", "/admin/c/general/10.json?page=0"],
    ["dot segments", "/c/../site.json?page=0"],
    ["encoded dot segments", "/c/%2e%2e/10.json?page=0"],
    ["another query", "/c/general/10.json?page=1"],
    ["no query", "/c/general/10.json"],
    ["a fragment", "/c/general/10.json?page=0#x"],
    ["no slug", "/c/10.json?page=0"],
    ["an empty location", ""],
  ];
  for (const [label, location] of refused) {
    const before = fake.requests.length;
    fake.failNext({ status: 301, headers: { location } });
    assert.equal(
      await codeOf(client.categoryPage(10, 0)),
      "DISCOURSE_BAD_RESPONSE",
      label,
    );
    assert.equal(fake.requests.length, before + 1, `${label}: nothing requested`);
  }

  // Only a category list is ever redirected: not site.json, a topic or a search.
  fake.failNext({
    status: 301,
    headers: { location: "/c/general/10.json?page=0" },
  });
  assert.equal(await codeOf(client.site()), "DISCOURSE_BAD_RESPONSE");
  fake.failNext({ status: 301, headers: { location: "/t/topic-1/1.json" } });
  assert.equal(await codeOf(client.topic(1)), "DISCOURSE_BAD_RESPONSE");
});

test("redirects are bounded: a third hop is refused", async () => {
  const { fake, client } = harness();
  fake.failNext(
    { status: 301, headers: { location: "/c/a/10.json?page=0" } },
    3,
  );
  assert.equal(await codeOf(client.categoryPage(10, 0)), "DISCOURSE_BAD_RESPONSE");
  assert.equal(fake.requests.length, 3);
});

test("an invalid base is refused at construction", () => {
  const fake = startFakeDiscourse(sampleForum());
  for (const base of [
    "http://forum.example.com",
    "https://127.0.0.1",
    "https://forum.example.com/",
    "https://forum.example.com/a/../b",
    "",
  ]) {
    assert.throws(
      () => createDiscourseClient({ fetch: fake.fetch, base }),
      (e: unknown) =>
        e instanceof DiscourseError && e.code === "DISCOURSE_FORUM_URL_INVALID",
    );
  }
  assert.equal(fake.requests.length, 0);
});

test("paths outside the allow-list and bad ids are refused before any request", async () => {
  const { fake, client, transport } = harness();
  for (const path of [
    "admin/users.json",
    "/site.json",
    "../site.json",
    "site.json?x=1",
    "site.json/",
    "https://evil.example/site.json",
    "c/abc.json",
    "c/0.json",
    "c/01.json",
    "c/1.5.json",
    "c/-1.json",
    "c/1/2.json",
    "t/1/posts.json/x",
    "t/%31.json",
    "t//posts.json",
    "latest.json",
    "",
  ]) {
    assert.equal(
      await codeOf(transport.getJson(path)),
      "DISCOURSE_CONFIG_INVALID",
      path,
    );
  }
  assert.equal(
    await codeOf(transport.getJson("site.json", { foo: "x" })),
    "DISCOURSE_CONFIG_INVALID",
  );
  assert.equal(
    await codeOf(transport.getJson("site.json", { page: 1.5 })),
    "DISCOURSE_CONFIG_INVALID",
  );
  assert.equal(
    await codeOf(transport.getJson("site.json", { page: -1 })),
    "DISCOURSE_CONFIG_INVALID",
  );
  assert.equal(
    await codeOf(transport.getJson("search.json", { page: 100_001 })),
    "DISCOURSE_CONFIG_INVALID",
  );
  const calls: Promise<unknown>[] = [
    client.categoryPage(1.5, 0),
    client.categoryPage(0, 0),
    client.categoryPage(1, -1),
    client.categoryPage(1, 0.5),
    client.categoryPage("1" as unknown as number, 0),
    client.topic(Number.NaN),
    client.topic(-3),
    client.topic(2 ** 53),
    client.topicPosts(1, []),
    client.topicPosts(1, [1.5]),
    client.topicPosts(1, [0]),
    client.topicPosts(
      1,
      Array.from({ length: 21 }, (_, i) => i + 1),
    ),
    client.search("", 1),
    client.search("x".repeat(600), 1),
    client.search("x", 0),
    client.search(5 as unknown as string, 1),
  ];
  for (const call of calls) {
    assert.equal(await codeOf(call), "DISCOURSE_CONFIG_INVALID");
  }
  assert.equal(fake.requests.length, 0);
});

test("a subfolder base builds base/site.json", async () => {
  const { fake, client } = harness(sampleForum({ basePath: "/forum" }));
  await client.site();
  await client.topic(1);
  assert.equal(fake.requests[0]!.url, `${BASE}/forum/site.json`);
  assert.equal(fake.requests[1]!.path, "/forum/t/1.json");
});

test("site() returns the flat category list", async () => {
  const { client } = harness();
  const site = await client.site();
  assert.deepEqual(
    site.categories.map((c) => [c.id, c.parentId, c.readRestricted, c.name]),
    [
      [10, null, false, "General"],
      [11, 10, false, "Support"],
      [12, null, true, "Staff"],
    ],
  );
  assert.equal(typeof site.categories[0]!.id, "number");
});

test("categoryPage pages 30 at a time and only reports whether more exist", async () => {
  const { fake, client } = harness(sampleForum({ topics: 35 }));
  const first = await client.categoryPage(10, 0);
  assert.ok(!isNotFound(first));
  assert.equal(first.topics.length, FAKE_PAGE_SIZE);
  assert.equal(first.hasMore, true);
  assert.equal(first.topics[0]!.id, 1);
  assert.equal(first.topics[0]!.slug, "topic-1");
  assert.equal(first.topics[0]!.categoryId, 10);
  assert.equal(first.topics[0]!.postsCount, 2);
  const second = await client.categoryPage(10, 1);
  assert.ok(!isNotFound(second));
  assert.equal(second.topics.length, 5);
  assert.equal(second.hasMore, false);
  assert.equal(fake.requests[0]!.path, "/c/10.json");
  assert.equal(fake.requests[0]!.query.page, "0");
  assert.equal(fake.requests[1]!.query.page, "1");
});

test("more_topics_url is never followed", async () => {
  const { fake, client } = harness(sampleForum({ topics: 35 }));
  const page = await client.categoryPage(10, 0);
  assert.ok(!isNotFound(page));
  assert.equal(page.hasMore, true);
  assert.equal(fake.requests.length, 1);
});

test("topic() returns the first posts and the full stream of numeric ids", async () => {
  const forum = sampleForum({ topics: 1 });
  const topic = forum.topics[0]!;
  topic.posts = Array.from({ length: 25 }, (_, i) => ({
    id: 500 + i,
    post_number: i + 1,
    username: "alice",
    cooked: `<p>post ${i + 1}</p>`,
  }));
  topic.tags = ["a", "b"];
  const { client } = harness(forum);
  const result = await client.topic(1);
  assert.ok(!isNotFound(result));
  assert.equal(result.id, 1);
  assert.equal(result.slug, "topic-1");
  assert.equal(result.categoryId, 10);
  assert.deepEqual(result.tags, ["a", "b"]);
  assert.equal(result.postsCount, 25);
  assert.equal(result.highestPostNumber, 25);
  assert.equal(result.posts.length, 20);
  assert.equal(result.stream.length, 25);
  assert.ok(result.stream.every((id) => typeof id === "number"));
  assert.equal(result.posts[0]!.postNumber, 1);
  assert.equal(result.posts[0]!.username, "alice");
  assert.equal(result.posts[0]!.cooked, "<p>post 1</p>");
  assert.equal(result.closed, false);
  assert.equal(result.visible, true);
});

test("topicPosts requests ids as post_ids[] and returns numeric posts", async () => {
  const forum = sampleForum({ topics: 1 });
  forum.topics[0]!.posts = Array.from({ length: 25 }, (_, i) => ({
    id: 500 + i,
    post_number: i + 1,
    username: "u",
    cooked: "<p>x</p>",
  }));
  const { fake, client } = harness(forum);
  const posts = await client.topicPosts(1, [520, 521, 524]);
  assert.ok(!isNotFound(posts));
  assert.deepEqual(
    posts.map((p) => [p.id, p.postNumber, p.topicId]),
    [
      [520, 21, 1],
      [521, 22, 1],
      [524, 25, 1],
    ],
  );
  assert.equal(fake.requests[0]!.path, "/t/1/posts.json");
  assert.deepEqual(fake.requests[0]!.queryAll["post_ids[]"], [
    "520",
    "521",
    "524",
  ]);
});

test("search() returns topics, posts and whether more pages exist", async () => {
  const { fake, client } = harness();
  const found = await client.search("topic 2", 1);
  assert.deepEqual(
    found.topics.map((t) => t.id),
    [2],
  );
  assert.equal(found.hasMore, false);
  assert.equal(fake.requests[0]!.path, "/search.json");
  assert.equal(fake.requests[0]!.query.q, "topic 2");
  assert.equal(fake.requests[0]!.query.page, "1");
  const none = await client.search("nothing-matches-this", 1);
  assert.deepEqual(none.topics, []);
  assert.deepEqual(none.posts, []);
});

test("posts carry the fields the adapter needs", async () => {
  const forum = sampleForum({ topics: 1 });
  forum.topics[0]!.posts[1] = {
    id: 9,
    post_number: 2,
    username: "bob",
    name: "Bob B",
    cooked: "<p>x</p>",
    reply_to_post_number: 1,
    hidden: true,
    post_type: 3,
    deleted_at: "2026-02-02T00:00:00.000Z",
    user_deleted: true,
    version: 4,
  };
  const { client } = harness(forum);
  const topic = await client.topic(1);
  assert.ok(!isNotFound(topic));
  const reply = topic.posts[1]!;
  assert.equal(reply.name, "Bob B");
  assert.equal(reply.replyToPostNumber, 1);
  assert.equal(reply.hidden, true);
  assert.equal(reply.postType, 3);
  assert.equal(reply.deletedAt, "2026-02-02T00:00:00.000Z");
  assert.equal(reply.userDeleted, true);
  assert.equal(reply.version, 4);
});

test("status table: 403, 404, 410, other 4xx/5xx, redirects", async () => {
  const forum = sampleForum();
  const { fake, client } = harness(forum);

  fake.setForum({ ...forum, loginRequired: true });
  assert.equal(await codeOf(client.site()), "DISCOURSE_LOGIN_REQUIRED");
  assert.equal(await codeOf(client.topic(1)), "DISCOURSE_LOGIN_REQUIRED");
  fake.setForum(forum);

  fake.failNext({ status: 404 });
  assert.equal(await codeOf(client.site()), "DISCOURSE_NOT_A_DISCOURSE_SITE");

  assert.ok(isNotFound(await client.topic(999)));
  assert.ok(isNotFound(await client.categoryPage(999, 0)));
  assert.ok(isNotFound(await client.topicPosts(999, [1])));
  forum.topics[0]!.gone = true;
  fake.setForum(forum);
  assert.ok(isNotFound(await client.topic(1)));
  assert.ok(isNotFound(await client.topicPosts(1, [1001])));

  for (const status of [400, 401, 418, 500]) {
    const before = fake.requests.length;
    fake.failNext({ status });
    assert.equal(await codeOf(client.topic(2)), "DISCOURSE_FORUM_UNREACHABLE");
    assert.equal(fake.requests.length, before + 1, `no retry for ${status}`);
  }
  fake.failNext({ status: 404 });
  assert.equal(
    await codeOf(client.search("x", 1)),
    "DISCOURSE_FORUM_UNREACHABLE",
  );

  for (const status of [301, 302, 307, 308]) {
    fake.failNext({ status, headers: { location: "https://evil.example/" } });
    assert.equal(await codeOf(client.topic(2)), "DISCOURSE_BAD_RESPONSE");
  }
  assert.ok(
    fake.requests.every((r) => !r.url.includes("evil.example")),
    "a redirect target is never requested",
  );
  fake.failNext({ status: 204 });
  assert.equal(await codeOf(client.topic(2)), "DISCOURSE_BAD_RESPONSE");
});

test("a 5xx that signals overload is retried, then unreachable", async () => {
  const { fake, client, sleeps } = harness();
  fake.failNext({ status: 503 }, 1);
  assert.ok(!isNotFound(await client.topic(1)));
  assert.equal(fake.requests.length, 2);
  assert.equal(sleeps.length, 1);

  fake.failNext({ status: 502 }, 3);
  assert.equal(await codeOf(client.topic(1)), "DISCOURSE_FORUM_UNREACHABLE");
  assert.equal(fake.requests.length, 5);
});

test("429 with Retry-After retries after that many seconds", async () => {
  const { fake, client, sleeps } = harness();
  fake.failNext({ status: 429, headers: { "retry-after": "2" } });
  const site = await client.site();
  assert.equal(site.categories.length, 3);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(fake.requests.length, 2);
});

test("429 body extras.wait_seconds is honoured without a header", async () => {
  const { fake, client, sleeps } = harness();
  fake.failNext({
    status: 429,
    body: JSON.stringify({ extras: { wait_seconds: 3 } }),
  });
  await client.site();
  assert.deepEqual(sleeps, [3000]);
});

test("the Retry-After header wins over the body", async () => {
  const { fake, client, sleeps } = harness();
  fake.failNext({
    status: 429,
    headers: { "retry-after": "1" },
    body: JSON.stringify({ extras: { wait_seconds: 9 } }),
  });
  await client.site();
  assert.deepEqual(sleeps, [1000]);
});

test("a long Retry-After is capped", async () => {
  const { fake, client, sleeps } = harness();
  fake.failNext({ status: 429, headers: { "retry-after": "99999" } });
  await client.site();
  assert.deepEqual(sleeps, [MAX_RETRY_DELAY_MS]);
});

test("a 429 without any hint still waits a bounded time", async () => {
  const { fake, client, sleeps } = harness();
  fake.failNext({ status: 429, body: "not json" });
  await client.site();
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0]! > 0 && sleeps[0]! <= MAX_RETRY_DELAY_MS);
});

test("429 beyond the retries is RATE_LIMITED", async () => {
  const { fake, client, sleeps } = harness();
  fake.failNext({ status: 429, headers: { "retry-after": "1" } }, 10);
  assert.equal(await codeOf(client.site()), "DISCOURSE_RATE_LIMITED");
  assert.equal(fake.requests.length, 3);
  assert.equal(sleeps.length, 2);
});

test("a network failure is retried and then unreachable", async () => {
  const { fake, client } = harness();
  fake.failNext({ networkError: true }, 1);
  await client.site();
  assert.equal(fake.requests.length, 2);
  fake.failNext({ networkError: true }, 10);
  assert.equal(await codeOf(client.site()), "DISCOURSE_FORUM_UNREACHABLE");
  assert.equal(fake.requests.length, 5);
});

test("the host's endpoint-not-allowed error becomes BLOCKED_ENDPOINT without a retry", async () => {
  let calls = 0;
  const blocked = (async () => {
    calls += 1;
    throw Object.assign(new Error("blocked https://forum.example.com"), {
      code: "ENDPOINT_NOT_ALLOWED",
    });
  }) as typeof fetch;
  const { client } = harness(sampleForum(), { fetch: blocked });
  assert.equal(await codeOf(client.site()), "DISCOURSE_BLOCKED_ENDPOINT");
  const viaCause = (async () => {
    calls += 1;
    throw new Error("wrapped", { cause: { code: "ENDPOINT_NOT_ALLOWED" } });
  }) as typeof fetch;
  const second = harness(sampleForum(), { fetch: viaCause });
  assert.equal(
    await codeOf(second.client.site()),
    "DISCOURSE_BLOCKED_ENDPOINT",
  );
  assert.equal(calls, 2);
});

test("non-JSON and non-object bodies are BAD_RESPONSE; site() says not a Discourse site", async () => {
  const { fake, client } = harness();
  fake.failNext({ status: 200, body: "<html>hello</html>" });
  assert.equal(await codeOf(client.topic(1)), "DISCOURSE_BAD_RESPONSE");
  fake.failNext({ status: 200, body: "[1,2]" });
  assert.equal(await codeOf(client.topic(1)), "DISCOURSE_BAD_RESPONSE");
  fake.failNext({ status: 200, body: "null" });
  assert.equal(await codeOf(client.topic(1)), "DISCOURSE_BAD_RESPONSE");
  fake.failNext({ status: 200, body: "{}" });
  assert.equal(await codeOf(client.topic(1)), "DISCOURSE_BAD_RESPONSE");
  fake.failNext({ status: 200, body: "<html>spa</html>" });
  assert.equal(await codeOf(client.site()), "DISCOURSE_NOT_A_DISCOURSE_SITE");
  fake.failNext({ status: 200, body: '{"hello":"world"}' });
  assert.equal(await codeOf(client.site()), "DISCOURSE_NOT_A_DISCOURSE_SITE");
});

test("a topic answer for another id is BAD_RESPONSE", async () => {
  const { fake, client } = harness();
  fake.failNext({
    status: 200,
    body: JSON.stringify({
      id: 7,
      title: "x",
      post_stream: { posts: [], stream: [] },
    }),
  });
  assert.equal(await codeOf(client.topic(1)), "DISCOURSE_BAD_RESPONSE");
});

function streamingFetch(
  chunks: Uint8Array[],
  state: { cancelled: boolean; pulled: number },
  headers: Record<string, string> = {},
): typeof fetch {
  return (async () => {
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulled += 1;
        const chunk = chunks[i];
        i += 1;
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return new Response(body, { status: 200, headers });
  }) as typeof fetch;
}

test("a body over maxResponseBytes is TOO_LARGE and the reader is cancelled", async () => {
  const state = { cancelled: false, pulled: 0 };
  const chunks = Array.from({ length: 50 }, () => new Uint8Array(40).fill(97));
  const { client } = harness(sampleForum(), {
    fetch: streamingFetch(chunks, state),
    maxResponseBytes: 100,
  });
  assert.equal(await codeOf(client.topic(1)), "DISCOURSE_TOO_LARGE");
  assert.equal(state.cancelled, true);
  assert.ok(state.pulled < 10, `stopped early (pulled ${state.pulled})`);
});

test("a declared content-length over the cap is TOO_LARGE without reading", async () => {
  const state = { cancelled: false, pulled: 0 };
  const { client } = harness(sampleForum(), {
    fetch: streamingFetch([new Uint8Array(10)], state, {
      "content-length": "5000",
    }),
    maxResponseBytes: 100,
  });
  assert.equal(await codeOf(client.topic(1)), "DISCOURSE_TOO_LARGE");
  assert.equal(state.cancelled, true);
});

test("gap sleeps happen between requests, not before the first", async () => {
  const { client, sleeps, clock } = harness();
  await client.site();
  assert.deepEqual(sleeps, []);
  await client.topic(1);
  assert.deepEqual(sleeps, [MIN_REQUEST_GAP_MS]);
  clock.t += 10_000;
  await client.topic(2);
  assert.deepEqual(sleeps, [MIN_REQUEST_GAP_MS]);
  clock.t += 100;
  await client.topic(3);
  assert.deepEqual(sleeps, [MIN_REQUEST_GAP_MS, MIN_REQUEST_GAP_MS - 100]);
});

test("the request after MAX_REQUESTS throws TOO_LARGE and is never sent", async () => {
  const { fake, client } = harness();
  for (let i = 0; i < MAX_REQUESTS; i += 1) await client.site();
  assert.equal(fake.requests.length, MAX_REQUESTS);
  assert.equal(await codeOf(client.site()), "DISCOURSE_TOO_LARGE");
  assert.equal(fake.requests.length, MAX_REQUESTS);
});

test("retries count towards the request ceiling", async () => {
  const { fake, client } = harness(sampleForum(), {
    limits: { maxRequests: 2 },
  });
  fake.failNext({ status: 429, headers: { "retry-after": "0" } }, 5);
  assert.equal(await codeOf(client.site()), "DISCOURSE_TOO_LARGE");
  assert.equal(fake.requests.length, 2);
});

test("a hung request times out and cleans its timer and abort listener", async () => {
  const controller = new AbortController();
  const { fake, client } = harness(sampleForum(), {
    requestTimeoutMs: 20,
    signal: controller.signal,
  });
  fake.failNext({ hang: true }, 1);
  assert.equal(await codeOf(client.site()), "DISCOURSE_FORUM_UNREACHABLE");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await client.site();
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("an aborted external signal stops the client before sending", async () => {
  const controller = new AbortController();
  const { fake, client } = harness(sampleForum(), {
    signal: controller.signal,
  });
  await client.site();
  controller.abort();
  assert.equal(await codeOf(client.site()), "DISCOURSE_FORUM_UNREACHABLE");
  assert.equal(fake.requests.length, 1);
});

test("errors never contain the base URL, host, path, digits or a cause", async () => {
  const base = "https://secret-forum.example.com/private-path";
  const forum = sampleForum({ basePath: "/private-path" });
  const { fake, client, transport } = harness(forum, { base });
  const failures: (() => Promise<unknown>)[] = [
    () => {
      fake.failNext({ status: 403 });
      return client.site();
    },
    () => {
      fake.failNext({ status: 404 });
      return client.site();
    },
    () => {
      fake.failNext({ status: 500 });
      return client.topic(1);
    },
    () => {
      fake.failNext({ status: 301 });
      return client.topic(1);
    },
    () => {
      fake.failNext({ status: 200, body: "oops" });
      return client.topic(1);
    },
    () => {
      fake.failNext({ status: 429 }, 5);
      return client.topic(1);
    },
    () => {
      fake.failNext({ networkError: true }, 5);
      return client.topic(1);
    },
    () => transport.getJson("admin.json"),
  ];
  for (const failure of failures) {
    let caught: unknown;
    try {
      await failure();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof DiscourseError, String(caught));
    for (const secret of ["secret-forum", "private-path", "example.com"]) {
      assert.ok(!caught.message.includes(secret), caught.message);
    }
    assert.ok(!/\d/.test(caught.message), caught.message);
    assert.equal(caught.cause, undefined);
  }
});

test("the client never touches the global fetch", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("global fetch used");
  }) as typeof fetch;
  try {
    const { client } = harness();
    await client.site();
  } finally {
    globalThis.fetch = original;
  }
});

const INVALID_ACCESS = JSON.stringify({
  errors: ["You are not permitted to view the requested resource."],
  error_type: "invalid_access",
});

test("a restricted topic, category or post list is NotFound", async () => {
  const forum = sampleForum();
  forum.topics[0]!.restricted = true;
  forum.categories[2]!.restricted = true;
  const { client } = harness(forum);
  assert.ok(isNotFound(await client.topic(1)));
  assert.ok(isNotFound(await client.topicPosts(1, [1001])));
  assert.ok(isNotFound(await client.categoryPage(12, 0)));
  // The neighbours are untouched.
  assert.ok(!isNotFound(await client.topic(2)));
  assert.ok(!isNotFound(await client.categoryPage(10, 0)));
});

test("any other 403 on a topic, category or post list stays LOGIN_REQUIRED", async () => {
  const { fake, client } = harness();
  const calls: [string, () => Promise<unknown>][] = [
    ["category", () => client.categoryPage(10, 0)],
    ["topic", () => client.topic(1)],
    ["posts", () => client.topicPosts(1, [1001])],
  ];
  const bodies: [string, string][] = [
    ["a challenge page", "<html><title>Just a moment...</title></html>"],
    ["an empty body", ""],
    ["another error_type", '{"error_type":"not_logged_in","errors":["x"]}'],
    ["no error_type", '{"errors":["x"]}'],
    ["an array", '[{"error_type":"invalid_access"}]'],
    ["a string error_type in an array", '["invalid_access"]'],
    [
      "an oversized body",
      JSON.stringify({ error_type: "invalid_access", pad: "x".repeat(70_000) }),
    ],
  ];
  for (const [path, call] of calls) {
    for (const [what, body] of bodies) {
      fake.failNext({ status: 403, body });
      assert.equal(
        await codeOf(call()),
        "DISCOURSE_LOGIN_REQUIRED",
        `${path} with ${what}`,
      );
    }
    // A 403 with the restricted body is NotFound on the same path.
    fake.failNext({ status: 403, body: INVALID_ACCESS });
    assert.ok(isNotFound(await call()), `${path} invalid_access`);
  }
});

test("a login-required forum is LOGIN_REQUIRED on every path", async () => {
  const forum = { ...sampleForum(), loginRequired: true };
  const { client } = harness(forum);
  for (const call of [
    () => client.site(),
    () => client.categoryPage(10, 0),
    () => client.topic(1),
    () => client.topicPosts(1, [1001]),
    () => client.search("topic", 1),
  ]) {
    assert.equal(await codeOf(call()), "DISCOURSE_LOGIN_REQUIRED");
  }
});

test("a restricted-looking 403 on site.json or search.json is still LOGIN_REQUIRED", async () => {
  const { fake, client } = harness();
  fake.failNext({ status: 403, body: INVALID_ACCESS });
  assert.equal(await codeOf(client.site()), "DISCOURSE_LOGIN_REQUIRED");
  fake.failNext({ status: 403, body: INVALID_ACCESS });
  assert.equal(await codeOf(client.search("x", 1)), "DISCOURSE_LOGIN_REQUIRED");
});

test("the 403 body is read through a capped, cancelled reader", async () => {
  const state = { cancelled: false, pulled: 0 };
  const chunks = Array.from({ length: 200 }, () =>
    new Uint8Array(1024).fill(97),
  );
  const forbidden = (async () => {
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulled += 1;
        const chunk = chunks[i];
        i += 1;
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return new Response(body, { status: 403 });
  }) as typeof fetch;
  const { client } = harness(sampleForum(), { fetch: forbidden });
  assert.equal(await codeOf(client.topic(1)), "DISCOURSE_LOGIN_REQUIRED");
  assert.equal(state.cancelled, true);
  assert.ok(state.pulled < 100, `stopped early (pulled ${state.pulled})`);
});

test("the gap is measured from the end of the previous response", async () => {
  const fake = startFakeDiscourse(sampleForum());
  const sleeps: number[] = [];
  const clock = { t: 1_000 };
  // Each request takes 100 ms of (injected) time.
  const slow = (async (...args: Parameters<typeof fetch>) => {
    const response = await fake.fetch(...args);
    clock.t += 100;
    return response;
  }) as typeof fetch;
  const client = createDiscourseClient({
    fetch: slow,
    base: BASE,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
  });
  await client.site();
  assert.deepEqual(sleeps, []);
  // The first request ended just now: a full gap is still owed.
  await client.topic(1);
  assert.deepEqual(sleeps, [MIN_REQUEST_GAP_MS]);
  clock.t += MIN_REQUEST_GAP_MS - 1;
  await client.topic(2);
  assert.deepEqual(sleeps, [MIN_REQUEST_GAP_MS, 1]);
});

test("a category lists its subcategories' topics, most recently bumped first, 30 per page", async () => {
  const forum = sampleForum({ topics: 0 });
  // 10 is the parent of 11; 11 is the parent of 13; 12 is unrelated.
  forum.categories.push({
    id: 13,
    name: "Deep",
    slug: "deep",
    parent_category_id: 11,
  });
  const at = (day: number) =>
    `2026-03-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  const topic = (id: number, categoryId: number, day: number) => ({
    id,
    title: `T${id}`,
    slug: `t${id}`,
    category_id: categoryId,
    bumped_at: at(day),
    posts: [{ id: id * 10, post_number: 1, username: "a", cooked: "<p>x</p>" }],
  });
  forum.topics = [
    topic(1, 10, 1),
    topic(2, 11, 5),
    topic(3, 13, 3),
    topic(4, 12, 9),
    ...Array.from({ length: 30 }, (_, i) => topic(100 + i, 11, 10 + i)),
  ];
  const { client } = harness(forum);
  const first = await client.categoryPage(10, 0);
  assert.ok(!isNotFound(first));
  assert.equal(first.topics.length, 30);
  assert.equal(first.hasMore, true);
  assert.equal(first.topics[0]!.id, 129); // newest bump first
  const second = await client.categoryPage(10, 1);
  assert.ok(!isNotFound(second));
  assert.deepEqual(
    second.topics.map((t) => t.id),
    [2, 3, 1],
  );
  assert.equal(second.hasMore, false);
  const own = await client.categoryPage(12, 0);
  assert.ok(!isNotFound(own));
  assert.deepEqual(
    own.topics.map((t) => t.id),
    [4],
  );
});

test("mutateNext rewrites headers of the next served response", async () => {
  const { fake, client } = harness();
  fake.mutateNext({ "content-length": "99999999999" });
  assert.equal(await codeOf(client.site()), "DISCOURSE_TOO_LARGE");
  // Only the next response was touched.
  assert.equal((await client.site()).categories.length, 3);
});
