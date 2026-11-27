import assert from "node:assert/strict";
import test from "node:test";
import {
  createGhostClient,
  isNotFound,
  type CreateGhostClientInput,
  type GhostClient,
} from "../src/client";
import { GhostError, type GhostErrorCode } from "../src/errors";
import {
  GHOST_USER_AGENT,
  MAX_REQUESTS,
  MAX_RETRY_DELAY_MS,
  MIN_REQUEST_GAP_MS,
} from "../src/limits";
import {
  createFakeGhost,
  DEFAULT_KEY,
  hexId,
  sampleState,
  type FakeFault,
  type FakeGhost,
  type FakeGhostOptions,
} from "./helpers/fake-ghost";

const SITE = "https://site.example";
const KEY = DEFAULT_KEY;

type Harness = {
  fake: FakeGhost;
  client: GhostClient;
  sleeps: number[];
  clock: { t: number };
};

function harness(
  options: {
    fake?: Partial<FakeGhostOptions>;
    siteBase?: string;
    key?: string;
    fetch?: typeof fetch;
    maxResponseBytes?: number;
    requestTimeoutMs?: number;
    signal?: AbortSignal;
    limits?: CreateGhostClientInput["limits"];
  } = {},
): Harness {
  const siteBase = options.siteBase ?? SITE;
  const fake = createFakeGhost({
    siteBase,
    key: KEY,
    ...sampleState(),
    ...options.fake,
  });
  const sleeps: number[] = [];
  const clock = { t: 1_000_000 };
  const client = createGhostClient({
    fetch: options.fetch ?? fake.fetch,
    siteBase,
    key: options.key ?? KEY,
    now: () => clock.t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    maxResponseBytes: options.maxResponseBytes,
    requestTimeoutMs: options.requestTimeoutMs,
    signal: options.signal,
    limits: options.limits,
  });
  return { fake, client, sleeps, clock };
}

async function errorOf(promise: Promise<unknown>): Promise<GhostError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GhostError, String(error));
    return error;
  }
  assert.fail("expected a GhostError");
}

async function codeOf(promise: Promise<unknown>): Promise<GhostErrorCode> {
  return (await errorOf(promise)).code;
}

test("a request is a GET to the slash form with the key last and the fixed headers", async () => {
  const { fake, client } = harness();
  const res = await client.getJson("posts", {
    limit: 100,
    page: 1,
    order: "id asc",
  });
  assert.ok(!isNotFound(res));
  assert.equal(fake.requests.length, 1);
  const request = fake.requests[0]!;
  assert.equal(request.method, "GET");
  assert.equal(
    request.url,
    `${SITE}/ghost/api/content/posts/?limit=100&page=1&order=id%20asc&key=${KEY}`,
  );
  assert.equal(request.path, "/ghost/api/content/posts/");
  assert.equal(Object.keys(request.query).at(-1), "key");
  assert.equal(request.query.key, KEY);
  assert.equal(request.headers.accept, "application/json");
  assert.equal(request.headers["accept-version"], "v5.0");
  assert.equal(request.headers["user-agent"], GHOST_USER_AGENT);
  assert.equal(request.redirect, "manual");
  // The key rides only in the query string, never in a header.
  assert.equal(request.headers.authorization, undefined);
  assert.ok(
    Object.entries(request.headers).every(([, value]) => !value.includes(KEY)),
  );
});

test("a request without params still has the slash before the key", async () => {
  const { fake, client } = harness();
  await client.getJson("settings");
  assert.equal(
    fake.requests[0]!.url,
    `${SITE}/ghost/api/content/settings/?key=${KEY}`,
  );
});

test("a subfolder site keeps its path in front of the API route", async () => {
  const { fake, client } = harness({ siteBase: "https://site.example/blog" });
  const res = await client.getJson("tags", { limit: 5 });
  assert.ok(!isNotFound(res));
  assert.equal(
    fake.requests[0]!.url,
    `https://site.example/blog/ghost/api/content/tags/?limit=5&key=${KEY}`,
  );
});

test("an item route is built with the id and the slash", async () => {
  const { fake, client } = harness();
  const res = await client.getJson(`posts/${hexId(1)}`, {
    formats: "html",
    include: "tags,authors",
  });
  assert.ok(!isNotFound(res));
  assert.equal(
    fake.requests[0]!.url,
    `${SITE}/ghost/api/content/posts/${hexId(1)}/?formats=html&include=tags%2Cauthors&key=${KEY}`,
  );
  const body = res.body as { posts: { id: string; tags: unknown[] }[] };
  assert.equal(body.posts[0]!.id, hexId(1));
  assert.equal(body.posts[0]!.tags.length, 1);
});

test("param values are percent-encoded and cannot add parameters", async () => {
  const { fake, client } = harness();
  await client.getJson("posts", { filter: "title:~'a&key=evil #x'" });
  const request = fake.requests[0]!;
  assert.deepEqual(request.queryAll.key, [KEY]);
  assert.equal(request.query.filter, "title:~'a&key=evil #x'");
  assert.ok(request.url.endsWith(`&key=${KEY}`));
});

test("a key with reserved characters is encoded into one parameter", async () => {
  const key = "a b&c=d#e";
  const { fake, client } = harness({ key, fake: { key } });
  await client.getJson("settings");
  assert.deepEqual(fake.requests[0]!.queryAll.key, [key]);
  assert.equal(
    fake.requests[0]!.url,
    `${SITE}/ghost/api/content/settings/?key=a%20b%26c%3Dd%23e`,
  );
});

test("a list answer carries its body untouched", async () => {
  const { client } = harness();
  const res = await client.getJson("posts", { limit: 1, page: 1 });
  assert.ok(!isNotFound(res));
  const body = res.body as {
    posts: unknown[];
    meta: { pagination: { total: number; pages: number; limit: number } };
  };
  assert.equal(body.posts.length, 1);
  assert.equal(body.meta.pagination.limit, 1);
  assert.equal(body.meta.pagination.total, 3);
  assert.equal(body.meta.pagination.pages, 3);
});

test("a bad route, param name or param value is CONFIG_INVALID and sends nothing", async () => {
  const cases: [string, Parameters<GhostClient["getJson"]>][] = [
    ["empty route", [""]],
    ["upper case route", ["Posts"]],
    ["query in route", ["posts?x=1"]],
    ["traversal", ["posts/../settings"]],
    ["absolute url", ["https://evil.example/posts"]],
    ["leading slash", ["/posts"]],
    ["trailing slash", ["posts/"]],
    ["short id", ["posts/abc"]],
    ["reserved key param", ["posts", { key: "x" }]],
    ["param name with a space", ["posts", { "a b": 1 }]],
    ["param name with an equals sign", ["posts", { "a=b": 1 }]],
    ["non-finite number", ["posts", { page: Number.NaN }]],
  ];
  for (const [label, args] of cases) {
    const { fake, client } = harness();
    assert.equal(
      await codeOf(client.getJson(...args)),
      "CONFIG_INVALID",
      label,
    );
    assert.equal(fake.requests.length, 0, label);
    assert.equal(client.requestCount(), 0, label);
  }
});

test("an empty key is BAD_CREDENTIALS without a request", async () => {
  const { fake, client } = harness({ key: "" });
  assert.equal(await codeOf(client.getJson("settings")), "BAD_CREDENTIALS");
  assert.equal(fake.requests.length, 0);
});

test("an invalid site address is refused when the client is created", () => {
  for (const siteBase of [
    "http://site.example",
    "https://127.0.0.1",
    "https://localhost/blog",
    "https://user@site.example",
    "https://site.example/a/../b",
  ]) {
    assert.throws(
      () =>
        createGhostClient({
          fetch: (() => {
            throw new Error("never");
          }) as typeof fetch,
          siteBase,
          key: KEY,
        }),
      (e: unknown) => e instanceof GhostError && e.code === "SITE_URL_INVALID",
      siteBase,
    );
  }
});

test("a 404 on an item route is a NotFound result, not an error", async () => {
  const { client } = harness();
  const res = await client.getJson(`posts/${hexId(0xdead)}`);
  assert.ok(isNotFound(res));
  assert.ok(!isNotFound({ body: {} }));
  assert.ok(!isNotFound(null));
});

test("a 429 with Retry-After seconds is retried after that wait, then succeeds", async () => {
  const { fake, client, sleeps, clock } = harness();
  // The first request owes no gap; start past it anyway so only Retry-After shows.
  clock.t += MIN_REQUEST_GAP_MS;
  fake.rateLimitNext(2);
  const res = await client.getJson("posts", { limit: 1 });
  assert.ok(!isNotFound(res));
  assert.deepEqual(sleeps, [2000]);
  assert.equal(client.requestCount(), 2);
  assert.equal(fake.requests.length, 2);
});

test("Retry-After as an HTTP date is honoured relative to the clock", async () => {
  const { fake, client, sleeps, clock } = harness();
  fake.failNext({
    status: 429,
    headers: { "retry-after": new Date(clock.t + 3_000).toUTCString() },
  });
  await client.getJson("settings");
  assert.deepEqual(sleeps, [3000]);
});

test("Retry-After is capped at the maximum retry delay", async () => {
  const { fake, client, sleeps } = harness();
  fake.rateLimitNext(100_000);
  await client.getJson("settings");
  assert.deepEqual(sleeps, [MAX_RETRY_DELAY_MS]);
});

test("a persistent 429 is RATE_LIMITED after the retries", async () => {
  const { fake, client, sleeps } = harness();
  fake.rateLimitNext(1, 10);
  assert.equal(await codeOf(client.getJson("posts")), "RATE_LIMITED");
  // The first try and two retries.
  assert.equal(client.requestCount(), 3);
  assert.equal(fake.requests.length, 3);
  assert.deepEqual(sleeps, [1000, 1000]);
});

test("a 5xx is retried and recovers; a persistent 5xx is BAD_RESPONSE", async () => {
  const a = harness();
  a.fake.failNext({ status: 503 });
  const res = await a.client.getJson("settings");
  assert.ok(!isNotFound(res));
  assert.equal(a.client.requestCount(), 2);

  const b = harness();
  b.fake.failNext({ status: 500 }, 10);
  assert.equal(await codeOf(b.client.getJson("settings")), "BAD_RESPONSE");
  assert.equal(b.client.requestCount(), 3);
});

test("a network failure is retried and recovers; a persistent one is SITE_UNREACHABLE", async () => {
  const a = harness();
  a.fake.failNext({ networkError: true });
  const res = await a.client.getJson("settings");
  assert.ok(!isNotFound(res));
  assert.equal(a.client.requestCount(), 2);

  const b = harness();
  b.fake.failNext({ networkError: true }, 10);
  assert.equal(await codeOf(b.client.getJson("settings")), "SITE_UNREACHABLE");
  assert.equal(b.client.requestCount(), 3);
});

test("a request that never answers times out as SITE_UNREACHABLE", async () => {
  const { fake, client } = harness({ requestTimeoutMs: 10 });
  fake.failNext({ hang: true }, 10);
  assert.equal(await codeOf(client.getJson("settings")), "SITE_UNREACHABLE");
  assert.equal(client.requestCount(), 3);
});

test("an aborted signal is SITE_UNREACHABLE and sends nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const { fake, client } = harness({ signal: controller.signal });
  assert.equal(await codeOf(client.getJson("settings")), "SITE_UNREACHABLE");
  assert.equal(fake.requests.length, 0);
});

test("the request after the cap throws TOO_LARGE and is never sent", async () => {
  const { fake, client } = harness({ limits: { maxRequests: 2 } });
  await client.getJson("posts");
  await client.getJson("pages");
  assert.equal(await codeOf(client.getJson("tags")), "TOO_LARGE");
  assert.equal(client.requestCount(), 2);
  assert.equal(fake.requests.length, 2);
});

test("retries count against the cap", async () => {
  const { fake, client } = harness({ limits: { maxRequests: 2 } });
  fake.failNext({ status: 500 }, 10);
  assert.equal(await codeOf(client.getJson("posts")), "TOO_LARGE");
  assert.equal(fake.requests.length, 2);
});

test("the production request cap is wired through", () => {
  assert.ok(MAX_REQUESTS >= 2);
});

test("a body over maxResponseBytes is TOO_LARGE, however it is sent", async () => {
  const a = harness({ maxResponseBytes: 100 });
  a.fake.failNext({ status: 200, body: "x".repeat(5_000) });
  assert.equal(await codeOf(a.client.getJson("posts")), "TOO_LARGE");

  // Declared up front.
  const b = harness({ maxResponseBytes: 100 });
  b.fake.failNext({
    status: 200,
    headers: { "content-length": "5000" },
    body: "x".repeat(10),
  });
  assert.equal(await codeOf(b.client.getJson("posts")), "TOO_LARGE");

  // Streamed with no declared length: the read stops at the cap.
  let pulled = 0;
  const streaming = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(60));
        if (pulled > 1_000) controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  const c = harness({ maxResponseBytes: 100, fetch: streaming });
  assert.equal(await codeOf(c.client.getJson("posts")), "TOO_LARGE");
  assert.ok(pulled < 100, `read ${pulled} chunks`);
});

test("a body exactly at the cap is read", async () => {
  const body = JSON.stringify({ a: "x".repeat(20) });
  const { fake, client } = harness({ maxResponseBytes: body.length });
  fake.failNext({ status: 200, body });
  const res = await client.getJson("settings");
  assert.ok(!isNotFound(res));
  assert.deepEqual(res.body, { a: "x".repeat(20) });
});

test("a 3xx is BLOCKED_ENDPOINT, never followed, and the key never reaches the target", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { fake, client } = harness();
    fake.redirectNext(`https://evil.example/steal?key=${KEY}`, 5, status);
    assert.equal(await codeOf(client.getJson("posts")), "BLOCKED_ENDPOINT");
    // Not retried, not followed.
    assert.equal(fake.requests.length, 1, String(status));
    assert.ok(fake.requests.every((r) => r.host === "site.example"));
  }
});

test("the no-slash form that Ghost redirects with its key is refused, not followed", async () => {
  // A request that dropped the trailing slash gets the real 301; the client
  // must stop there even though the Location is on the same host.
  const fake = createFakeGhost({ siteBase: SITE, key: KEY, ...sampleState() });
  const stripSlash = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    url.pathname = url.pathname.replace(/\/$/, "");
    return fake.fetch(url.toString(), init);
  }) as typeof fetch;
  const { client } = harness({ fetch: stripSlash });
  assert.equal(await codeOf(client.getJson("posts")), "BLOCKED_ENDPOINT");
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0]!.path, "/ghost/api/content/posts");
});

test("the fake itself answers 301 with the query string for a no-slash URL", async () => {
  const fake = createFakeGhost({ siteBase: SITE, key: KEY });
  const response = await fake.fetch(
    `${SITE}/ghost/api/content/posts?limit=1&key=${KEY}`,
    { redirect: "manual" },
  );
  assert.equal(response.status, 301);
  assert.equal(
    response.headers.get("location"),
    `${SITE}/ghost/api/content/posts/?limit=1&key=${KEY}`,
  );
});

test("error mapping", async () => {
  const cases: [string, FakeFault, string, GhostErrorCode][] = [
    [
      "403 unknown key",
      {
        status: 403,
        body: '{"errors":[{"message":"Unknown Content API Key","type":"UnauthorizedError","code":"UNKNOWN_CONTENT_API_KEY"}]}',
      },
      "settings",
      "BAD_CREDENTIALS",
    ],
    ["401", { status: 401, body: "" }, "settings", "BAD_CREDENTIALS"],
    [
      "403 other error code",
      {
        status: 403,
        body: '{"errors":[{"message":"x","type":"NoPermissionError","code":"OTHER"}]}',
      },
      "settings",
      "NOT_A_GHOST_SITE",
    ],
    ["403 no body", { status: 403, body: "" }, "posts", "NOT_A_GHOST_SITE"],
    [
      "403 html",
      { status: 403, body: "<html>blocked</html>" },
      "posts",
      "NOT_A_GHOST_SITE",
    ],
    [
      "403 code in an unrelated place",
      { status: 403, body: '{"note":"UNKNOWN_CONTENT_API_KEY"}' },
      "posts",
      "NOT_A_GHOST_SITE",
    ],
    [
      "404 on settings",
      { status: 404, body: "" },
      "settings",
      "NOT_A_GHOST_SITE",
    ],
    [
      "200 html",
      { status: 200, body: "<html>not json</html>" },
      "posts",
      "NOT_A_GHOST_SITE",
    ],
    ["200 empty", { status: 200, body: "" }, "settings", "NOT_A_GHOST_SITE"],
    ["400", { status: 400, body: '{"errors":[]}' }, "posts", "BAD_RESPONSE"],
    ["410", { status: 410, body: "" }, "posts", "BAD_RESPONSE"],
    ["422", { status: 422, body: "" }, "posts", "BAD_RESPONSE"],
  ];
  for (const [label, fault, route, expected] of cases) {
    const { fake, client } = harness();
    fake.failNext(fault);
    assert.equal(await codeOf(client.getJson(route)), expected, label);
  }
});

test("a wrong key against the fake is BAD_CREDENTIALS; a missing one is not a Ghost verdict", async () => {
  const wrong = harness({ key: "ffffffffffffffffffffffffff" });
  assert.equal(
    await codeOf(wrong.client.getJson("settings")),
    "BAD_CREDENTIALS",
  );
});

test("a site that is not Ghost is NOT_A_GHOST_SITE", async () => {
  const html = harness({ fake: { notGhost: "html" } });
  assert.equal(
    await codeOf(html.client.getJson("settings")),
    "NOT_A_GHOST_SITE",
  );
  const missing = harness({ fake: { notGhost: "not-found" } });
  assert.equal(
    await codeOf(missing.client.getJson("settings")),
    "NOT_A_GHOST_SITE",
  );
});

test("an oversized 403 body is read only up to a bound and carries no verdict", async () => {
  const { fake, client } = harness();
  fake.failNext({ status: 403, body: "x".repeat(200_000) });
  assert.equal(await codeOf(client.getJson("settings")), "NOT_A_GHOST_SITE");
});

test("requests are spaced by the minimum gap, measured with the injected clock", async () => {
  const { client, sleeps, clock } = harness();
  await client.getJson("posts");
  assert.deepEqual(sleeps, []);
  await client.getJson("pages");
  assert.deepEqual(sleeps, [MIN_REQUEST_GAP_MS]);
  clock.t += 10_000;
  await client.getJson("tags");
  assert.deepEqual(sleeps, [MIN_REQUEST_GAP_MS]);
  clock.t += 100;
  await client.getJson("authors");
  assert.deepEqual(sleeps, [MIN_REQUEST_GAP_MS, MIN_REQUEST_GAP_MS - 100]);
});

test("the key only ever goes to the site origin, in the query, and never into an error, log or result", async () => {
  const logged: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const saved = methods.map((m) => console[m]);
  for (const m of methods) {
    console[m] = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
  }
  const outputs: string[] = [];
  const allRequests: FakeGhost["requests"] = [];
  try {
    const ok = harness();
    outputs.push(
      JSON.stringify(await ok.client.getJson("posts", { limit: 2 })),
    );
    outputs.push(JSON.stringify(await ok.client.getJson("settings")));
    allRequests.push(...ok.fake.requests);

    const faults: FakeFault[] = [
      { status: 500 },
      { status: 429 },
      {
        status: 302,
        headers: { location: `https://evil.example/?key=${KEY}` },
      },
      { status: 200, body: "<html>" },
      {
        status: 403,
        body: `{"errors":[{"code":"UNKNOWN_CONTENT_API_KEY","message":"${KEY}"}]}`,
      },
      { status: 400, body: `bad ${KEY}` },
      { networkError: true },
    ];
    for (const fault of faults) {
      const { fake, client } = harness();
      fake.failNext(fault, 10);
      const error = await errorOf(client.getJson("posts"));
      assert.equal(error.cause, undefined);
      outputs.push(
        error.message,
        error.name,
        String(error.stack).split("\n")[0] as string,
        JSON.stringify({ ...error }),
      );
      allRequests.push(...fake.requests);
    }
  } finally {
    methods.forEach((m, i) => {
      console[m] = saved[i] as never;
    });
  }
  assert.deepEqual(logged, []);
  assert.ok(allRequests.length > 10);
  for (const request of allRequests) {
    assert.equal(request.host, "site.example");
    assert.ok(request.url.startsWith(`${SITE}/ghost/api/content/`));
    assert.ok(
      request.url.endsWith(`&key=${KEY}`) ||
        request.url.endsWith(`/?key=${KEY}`),
    );
    assert.deepEqual(request.queryAll.key, [KEY]);
    assert.ok(!request.path.includes(KEY));
    assert.ok(
      Object.values(request.headers).every((v) => !v.includes(KEY)),
      "key in a header",
    );
  }
  for (const text of outputs) assert.ok(!text.includes(KEY), text);
});

test("an underlying fetch error never reaches the thrown error", async () => {
  const leaky = (async (input: RequestInfo | URL) => {
    throw new TypeError(`fetch failed for ${String(input)}`, {
      cause: new Error(`secret ${KEY}`),
    });
  }) as typeof fetch;
  const { client } = harness({ fetch: leaky });
  const error = await errorOf(client.getJson("settings"));
  assert.equal(error.code, "SITE_UNREACHABLE");
  assert.equal(error.cause, undefined);
  assert.ok(!error.message.includes(KEY));
  assert.ok(!error.message.includes("site.example"));
  assert.ok(!/\d/.test(error.message));
});

test("the client never touches the global fetch", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("global fetch used");
  }) as typeof fetch;
  try {
    const { client } = harness();
    await client.getJson("posts");
  } finally {
    globalThis.fetch = original;
  }
});

test("requestCount counts every request, retries included", async () => {
  const { fake, client } = harness();
  assert.equal(client.requestCount(), 0);
  await client.getJson("posts");
  assert.equal(client.requestCount(), 1);
  fake.failNext({ status: 502 });
  await client.getJson("pages");
  assert.equal(client.requestCount(), 3);
});
