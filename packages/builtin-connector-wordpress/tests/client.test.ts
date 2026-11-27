import assert from "node:assert/strict";
import test from "node:test";
import {
  createWordPressClient,
  isNotFound,
  type CreateWordPressClientInput,
  type WordPressClient,
} from "../src/client";
import {
  WordPressError,
  type WordPressErrorCode,
  type WordPressRestCode,
} from "../src/errors";
import { MAX_REQUESTS, MIN_REQUEST_GAP_MS } from "../src/limits";
import {
  createFakeWordPress,
  samplePosts,
  type FakeWordPress,
  type FakeWordPressOptions,
} from "./helpers/fake-wordpress";

const SITE = "https://site.example";
const USER = "wpuser";
const SECRET = "app-pass-abcdef";
const AUTH = `Basic ${Buffer.from(`${USER}:${SECRET}`, "utf8").toString("base64")}`;

type Harness = {
  fake: FakeWordPress;
  client: WordPressClient;
  sleeps: number[];
  clock: { t: number };
};

function harness(
  options: {
    fake?: FakeWordPressOptions;
    fetch?: typeof fetch;
    authorization?: string;
    allowWpcom?: boolean;
    maxResponseBytes?: number;
    requestTimeoutMs?: number;
    signal?: AbortSignal;
    limits?: CreateWordPressClientInput["limits"];
  } = {},
): Harness {
  const fake = createFakeWordPress(
    options.fake ?? { siteBase: SITE, root: "pretty", posts: samplePosts() },
  );
  const sleeps: number[] = [];
  const clock = { t: 1_000_000 };
  const client = createWordPressClient({
    fetch: options.fetch ?? fake.fetch,
    siteBase: SITE,
    allowWpcom: options.allowWpcom ?? false,
    authorization: options.authorization,
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

async function codeOf(promise: Promise<unknown>): Promise<WordPressErrorCode> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof WordPressError, String(error));
    return error.code;
  }
  assert.fail("expected a WordPressError");
}

test("a REST request is GET with Accept and User-Agent, redirect manual, no auth for the public client", async () => {
  const { fake, client } = harness();
  const res = await client.getJson("/wp/v2/posts", { per_page: 100, page: 1 });
  assert.ok(!isNotFound(res));
  const rest = fake.requests.find((r) => r.url.includes("wp/v2/posts"))!;
  assert.equal(rest.method, "GET");
  assert.equal(rest.headers.accept, "application/json");
  assert.match(
    rest.headers["user-agent"] ?? "",
    /^SourceWeft-WordPressConnector\/1\.0/,
  );
  assert.equal(rest.headers.authorization, undefined);
  assert.equal(rest.redirect, "manual");
  assert.equal(rest.url, `${SITE}/wp-json/wp/v2/posts?per_page=100&page=1`);
});

test("discover() is cached: the home page is fetched once", async () => {
  const { fake, client } = harness();
  const a = await client.discover();
  const b = await client.discover();
  assert.deepEqual(a, b);
  await client.getJson("/wp/v2/posts");
  assert.equal(fake.requests.filter((r) => r.url === `${SITE}/`).length, 1);
});

test("getJson reports X-WP-Total and X-WP-TotalPages", async () => {
  const { client } = harness();
  const res = await client.getJson("/wp/v2/posts", { per_page: 1, page: 1 });
  assert.ok(!isNotFound(res));
  assert.equal(res.total, 2);
  assert.equal(res.totalPages, 2);
  assert.ok(Array.isArray(res.body));
  assert.equal((res.body as unknown[]).length, 1);
});

test("missing totals headers are null", async () => {
  const { fake, client } = harness();
  await client.discover();
  fake.failNext({ status: 200, body: "[]" });
  const res = await client.getJson("/wp/v2/posts");
  assert.ok(!isNotFound(res));
  assert.equal(res.total, null);
  assert.equal(res.totalPages, null);
});

test("getIndex returns the name and namespaces", async () => {
  const { client } = harness();
  const index = await client.getIndex();
  assert.equal(index.name, "Example");
  assert.ok(index.namespaces.includes("wp/v2"));
});

test("getIndex without wp/v2 is REST_DISABLED", async () => {
  const { client } = harness({
    fake: { siteBase: SITE, restDisabled: true, posts: [] },
  });
  assert.equal(await codeOf(client.getIndex()), "REST_DISABLED");
});

test("a 404 on a route is a NotFound result, not an error", async () => {
  const { fake, client } = harness();
  await client.discover();
  fake.failNext({ status: 404, body: '{"code":"rest_post_invalid_id"}' });
  const res = await client.getJson("/wp/v2/posts/999");
  assert.ok(isNotFound(res));
});

test("a 429 with Retry-After is retried, then succeeds", async () => {
  const { fake, client, sleeps, clock } = harness();
  await client.discover();
  // Past the gap that now follows the counted discovery request, so only the
  // Retry-After delay is observed.
  clock.t += MIN_REQUEST_GAP_MS;
  fake.failNext({ status: 429, headers: { "retry-after": "2" } });
  const res = await client.getJson("/wp/v2/posts", { per_page: 100 });
  assert.ok(!isNotFound(res));
  assert.deepEqual(sleeps, [2000]);
});

test("a persistent 429 is RATE_LIMITED after the retries", async () => {
  const { fake, client, sleeps, clock } = harness();
  await client.discover();
  clock.t += MIN_REQUEST_GAP_MS;
  const before = client.requestCount();
  fake.failNext({ status: 429, headers: { "retry-after": "1" } }, 10);
  assert.equal(await codeOf(client.getJson("/wp/v2/posts")), "RATE_LIMITED");
  assert.equal(client.requestCount() - before, 3);
  assert.equal(sleeps.length, 2);
});

test("the request after the cap throws TOO_LARGE and is never sent", async () => {
  // Budget 3: the discovery request plus two reads, then the next is refused.
  const { fake, client } = harness({ limits: { maxRequests: 3 } });
  await client.discover();
  const home = fake.requests.length;
  await client.getJson("/wp/v2/posts");
  await client.getJson("/wp/v2/pages");
  assert.equal(await codeOf(client.getJson("/wp/v2/users")), "TOO_LARGE");
  assert.equal(client.requestCount(), 3);
  assert.equal(fake.requests.length, home + 2);
});

test("a body over maxResponseBytes is TOO_LARGE", async () => {
  const { fake, client } = harness({ maxResponseBytes: 100 });
  await client.discover();
  fake.failNext({ status: 200, body: "x".repeat(5000) });
  assert.equal(await codeOf(client.getJson("/wp/v2/posts")), "TOO_LARGE");
});

test("a 3xx on a REST call is BLOCKED_ENDPOINT and never followed, no auth leaks", async () => {
  const { fake, client } = harness({ authorization: AUTH });
  await client.discover();
  fake.failNext({
    status: 302,
    headers: { location: "https://evil.example/x" },
  });
  assert.equal(
    await codeOf(client.getJson("/wp/v2/posts")),
    "BLOCKED_ENDPOINT",
  );
  assert.ok(fake.requests.every((r) => r.host !== "evil.example"));
});

test("error mapping for the public client", async () => {
  const cases: [
    string,
    Parameters<FakeWordPress["failNext"]>[0],
    WordPressErrorCode,
  ][] = [
    [
      "401 rest code",
      { status: 401, body: '{"code":"rest_not_logged_in"}' },
      "LOGIN_REQUIRED",
    ],
    [
      "403 rest code",
      { status: 403, body: '{"code":"rest_forbidden"}' },
      "LOGIN_REQUIRED",
    ],
    [
      "non-JSON 200",
      { status: 200, body: "<html>not json</html>" },
      "NOT_A_WORDPRESS_SITE",
    ],
    [
      "bare 400",
      { status: 400, body: '{"code":"rest_invalid_param"}' },
      "BAD_RESPONSE",
    ],
  ];
  for (const [label, fault, expected] of cases) {
    const { fake, client } = harness();
    await client.discover();
    fake.failNext(fault);
    assert.equal(await codeOf(client.getJson("/wp/v2/posts")), expected, label);
  }
});

test("a persistent 5xx is BAD_RESPONSE; a network failure is SITE_UNREACHABLE", async () => {
  const a = harness();
  await a.client.discover();
  a.fake.failNext({ status: 500 }, 10);
  assert.equal(await codeOf(a.client.getJson("/wp/v2/posts")), "BAD_RESPONSE");

  const b = harness();
  await b.client.discover();
  b.fake.failNext({ networkError: true }, 10);
  assert.equal(
    await codeOf(b.client.getJson("/wp/v2/posts")),
    "SITE_UNREACHABLE",
  );
});

test("credential mapping: incorrect password and an un-coded 401 are BAD_CREDENTIALS", async () => {
  const bad: [string, Parameters<FakeWordPress["failNext"]>[0]][] = [
    [
      "incorrect_password",
      { status: 401, body: '{"code":"incorrect_password"}' },
    ],
    ["invalid_username", { status: 403, body: '{"code":"invalid_username"}' }],
    ["401 with no rest code", { status: 401, body: "" }],
  ];
  for (const [label, fault] of bad) {
    const { fake, client } = harness({ authorization: AUTH });
    await client.discover();
    fake.failNext(fault);
    assert.equal(
      await codeOf(client.getJson("/wp/v2/posts")),
      "BAD_CREDENTIALS",
      label,
    );
  }
});

test("credential mapping: any credentialed 401 is BAD_CREDENTIALS, whatever the rest code", async () => {
  // A credentialed request that comes back 401 means the credential was
  // rejected or never reached WordPress (e.g. a host stripping Authorization),
  // so it is a credential failure, not a public-style login prompt.
  for (const body of [
    '{"code":"rest_not_logged_in"}',
    '{"code":"rest_login_required"}',
    '{"code":"rest_cannot_edit"}',
  ]) {
    const { fake, client } = harness({ authorization: AUTH });
    await client.discover();
    fake.failNext({ status: 401, body });
    assert.equal(
      await codeOf(client.getJson("/wp/v2/posts")),
      "BAD_CREDENTIALS",
      body,
    );
  }
});

test("credential mapping: a credentialed 403 rights refusal stays LOGIN_REQUIRED", async () => {
  const { fake, client } = harness({ authorization: AUTH });
  await client.discover();
  fake.failNext({ status: 403, body: '{"code":"rest_forbidden"}' });
  assert.equal(await codeOf(client.getJson("/wp/v2/posts")), "LOGIN_REQUIRED");
});

async function errorOf(promise: Promise<unknown>): Promise<WordPressError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof WordPressError, String(error));
    return error;
  }
  assert.fail("expected a WordPressError");
}

test("each recognised REST code is recorded on a 400/401/403 error", async () => {
  const cases: [number, unknown, WordPressRestCode][] = [
    [
      400,
      {
        code: "rest_invalid_param",
        data: {
          status: 400,
          details: { status: { code: "rest_forbidden_status" } },
        },
      },
      "rest_forbidden_status",
    ],
    [400, { code: "rest_invalid_param" }, "rest_invalid_param"],
    [403, { code: "rest_cannot_view" }, "rest_cannot_view"],
    [403, { code: "rest_forbidden" }, "rest_forbidden"],
    [401, { code: "rest_login_required" }, "rest_login_required"],
    [401, { code: "incorrect_password" }, "incorrect_password"],
    [403, { code: "invalid_username" }, "invalid_username"],
    [401, { code: "rest_not_logged_in" }, "rest_not_logged_in"],
    [401, { code: "rest_user_cannot_view" }, "rest_user_cannot_view"],
  ];
  for (const [status, body, expected] of cases) {
    const { fake, client } = harness({ authorization: AUTH });
    await client.discover();
    fake.failNext({ status, body: JSON.stringify(body) });
    const error = await errorOf(client.getJson("/wp/v2/posts"));
    assert.equal(error.restCode, expected, expected);
  }
});

test("rest_no_route (404) is recorded on the index error", async () => {
  const { fake, client } = harness();
  await client.discover();
  fake.failNext({ status: 404, body: '{"code":"rest_no_route"}' });
  const error = await errorOf(client.getIndex());
  assert.equal(error.code, "NOT_A_WORDPRESS_SITE");
  assert.equal(error.restCode, "rest_no_route");
});

test("rest_forbidden_status is read end-to-end from the fake's 400", async () => {
  // A public client that asks for a draft gets the real rest_invalid_param /
  // rest_forbidden_status body a live WordPress returns.
  const { client } = harness();
  const error = await errorOf(
    client.getJson("/wp/v2/posts", { status: "draft" }),
  );
  assert.equal(error.code, "BAD_RESPONSE");
  assert.equal(error.restCode, "rest_forbidden_status");
});

test("an unrecognised code or a non-JSON body leaves restCode unset", async () => {
  for (const fault of [
    { status: 400, body: '{"code":"rest_some_future_code"}' },
    { status: 400, body: "<html>not json</html>" },
    { status: 403, body: "" },
  ]) {
    const { fake, client } = harness();
    await client.discover();
    fake.failNext(fault);
    const error = await errorOf(client.getJson("/wp/v2/posts"));
    assert.equal(error.restCode, undefined, fault.body);
  }
});

test("no response text reaches the error message or its serialised fields", async () => {
  const { fake, client } = harness();
  await client.discover();
  fake.failNext({
    status: 400,
    body: JSON.stringify({
      code: "rest_invalid_param",
      message: "LEAKY-BODY-TEXT",
      data: { params: { status: "LEAKY-BODY-TEXT" } },
    }),
  });
  const error = await errorOf(client.getJson("/wp/v2/posts"));
  assert.equal(error.restCode, "rest_invalid_param");
  assert.ok(!error.message.includes("LEAKY-BODY-TEXT"));
  const serialised = JSON.stringify({
    code: error.code,
    status: error.status,
    message: error.message,
    restCode: error.restCode,
  });
  assert.ok(!serialised.includes("LEAKY-BODY-TEXT"));
});

test("the credential is sent only to the site origin and never appears in an error or a URL", async () => {
  const { fake, client } = harness({ authorization: AUTH });
  await client.getIndex();
  await client.getJson("/wp/v2/posts");
  const rest = fake.requests.filter((r) => r.url !== `${SITE}/`);
  assert.ok(rest.length >= 2);
  assert.ok(
    rest.every(
      (r) => r.host === "site.example" && r.headers.authorization === AUTH,
    ),
    "every REST request carries the credential to the site origin",
  );
  // Discovery (the home page) never carries the credential.
  const home = fake.requests.find((r) => r.url === `${SITE}/`)!;
  assert.equal(home.headers.authorization, undefined);
  // No request goes to any other host, and the secret is never in a URL.
  assert.ok(fake.requests.every((r) => r.host === "site.example"));
  assert.ok(fake.requests.every((r) => !r.url.includes(SECRET)));

  fake.failNext({ status: 500 }, 10);
  let caught: unknown;
  try {
    await client.getJson("/wp/v2/pages");
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof WordPressError, String(caught));
  assert.ok(!caught.message.includes(SECRET));
  assert.ok(!caught.message.includes(AUTH));
  assert.ok(!caught.message.includes("site.example"));
  assert.ok(!/\d/.test(caught.message));
  assert.equal(caught.cause, undefined);
});

test("requests are spaced by the minimum gap, measured with the injected clock", async () => {
  const { client, sleeps, clock } = harness();
  // Discovery is the first counted request, so it owes no gap.
  await client.discover();
  assert.deepEqual(sleeps, []);
  await client.getJson("/wp/v2/posts");
  assert.deepEqual(sleeps, [MIN_REQUEST_GAP_MS]);
  clock.t += 10_000;
  await client.getJson("/wp/v2/pages");
  assert.deepEqual(sleeps, [MIN_REQUEST_GAP_MS]);
  clock.t += 100;
  await client.getJson("/wp/v2/categories");
  assert.deepEqual(sleeps, [MIN_REQUEST_GAP_MS, MIN_REQUEST_GAP_MS - 100]);
});

test("the client never touches the global fetch", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("global fetch used");
  }) as typeof fetch;
  try {
    const { client } = harness();
    await client.getJson("/wp/v2/posts");
  } finally {
    globalThis.fetch = original;
  }
});

test("discovery counts toward the request budget", async () => {
  const { client } = harness();
  assert.equal(client.requestCount(), 0);
  await client.discover();
  // Discovery runs on the client's own transport, so its home-page request is
  // counted against MAX_REQUESTS like every REST read.
  assert.equal(client.requestCount(), 1);
  await client.getJson("/wp/v2/posts");
  assert.equal(client.requestCount(), 2);
  // A smoke check that the production constant wires through unchanged.
  assert.ok(MAX_REQUESTS >= 2);
});
