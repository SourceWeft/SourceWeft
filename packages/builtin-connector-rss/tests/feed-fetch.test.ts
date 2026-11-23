import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";
import { RssAdapterError } from "../src/errors";
import { fetchFeed, type FeedFetchResult } from "../src/feed-fetch";
import { FEED_USER_AGENT } from "../src/limits";

const SENTINEL = "SECRET-TOKEN-123";
const URL_WITH_TOKEN = `https://h.example/feed?token=${SENTINEL}`;

type Recorded = { url: string; init: RequestInit | undefined };
type Handler = (
  url: string,
  init: RequestInit | undefined,
) => Promise<Response> | Response;

function harness(handler: Handler) {
  const requests: Recorded[] = [];
  const state = { scopes: 0, closes: 0, fetchCalls: 0 };
  const publicFetch = (): ConnectorPublicFetchScope => {
    state.scopes += 1;
    return {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        state.fetchCalls += 1;
        requests.push({ url: String(input), init });
        return handler(String(input), init);
      }) as typeof fetch,
      close: async () => {
        state.closes += 1;
      },
    };
  };
  return { publicFetch, requests, state };
}

async function rejection(promise: Promise<unknown>): Promise<RssAdapterError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof RssAdapterError, "expected RssAdapterError");
    return error;
  }
  assert.fail("expected rejection");
}

function trackedStream(chunks: Uint8Array[], opts: { onCancel: () => void }) {
  let index = 0;
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(chunks[index++]);
    },
    cancel() {
      opts.onCancel();
    },
  });
  return { stream, pulled: () => pulled };
}

test("request carries the exact UA, an Accept header, no cookie or authorization", async () => {
  const h = harness(() => new Response("<rss/>", { status: 200 }));
  await fetchFeed({ publicFetch: h.publicFetch, feedUrl: URL_WITH_TOKEN });
  assert.equal(h.requests.length, 1);
  const headers = new Headers(h.requests[0]?.init?.headers);
  assert.equal(headers.get("user-agent"), FEED_USER_AGENT);
  assert.ok(headers.get("accept")?.startsWith("application/atom+xml"));
  assert.equal(headers.get("cookie"), null);
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("if-none-match"), null);
  assert.equal(headers.get("if-modified-since"), null);
  assert.equal(h.requests[0]?.init?.method, "GET");
  assert.ok(h.requests[0]?.init?.signal);
});

test("validators produce conditional headers", async () => {
  const h = harness(() => new Response("<rss/>"));
  await fetchFeed({
    publicFetch: h.publicFetch,
    feedUrl: "https://h.example/feed",
    validators: { etag: '"abc"', lastModified: "Wed, 01 Jan 2025 00:00:00 GMT" },
  });
  const headers = new Headers(h.requests[0]?.init?.headers);
  assert.equal(headers.get("if-none-match"), '"abc"');
  assert.equal(
    headers.get("if-modified-since"),
    "Wed, 01 Jan 2025 00:00:00 GMT",
  );
});

test("null validators send no conditional headers", async () => {
  const h = harness(() => new Response("<rss/>"));
  await fetchFeed({
    publicFetch: h.publicFetch,
    feedUrl: "https://h.example/feed",
    validators: { etag: null, lastModified: null },
  });
  const headers = new Headers(h.requests[0]?.init?.headers);
  assert.equal(headers.get("if-none-match"), null);
  assert.equal(headers.get("if-modified-since"), null);
});

test("304 is not_modified and closes the scope", async () => {
  const h = harness(() => new Response(null, { status: 304 }));
  const result = await fetchFeed({
    publicFetch: h.publicFetch,
    feedUrl: "https://h.example/feed",
  });
  assert.deepEqual(result, { kind: "not_modified" });
  assert.equal(h.state.closes, 1);
});

test("200 returns the body, validators and strips a UTF-8 BOM", async () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const text = new TextEncoder().encode("<rss>é</rss>");
  const bytes = new Uint8Array(bom.length + text.length);
  bytes.set(bom);
  bytes.set(text, bom.length);
  const h = harness(
    () =>
      new Response(bytes, {
        status: 200,
        headers: { etag: '"v1"', "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT" },
      }),
  );
  const result = (await fetchFeed({
    publicFetch: h.publicFetch,
    feedUrl: "https://h.example/feed",
  })) as Extract<FeedFetchResult, { kind: "feed" }>;
  assert.equal(result.kind, "feed");
  assert.equal(result.body, "<rss>é</rss>");
  assert.equal(result.etag, '"v1"');
  assert.equal(result.lastModified, "Wed, 01 Jan 2025 00:00:00 GMT");
  assert.equal(h.state.closes, 1);
});

test("missing validators on the response are null", async () => {
  const h = harness(() => new Response("<rss/>"));
  const result = (await fetchFeed({
    publicFetch: h.publicFetch,
    feedUrl: "https://h.example/feed",
  })) as Extract<FeedFetchResult, { kind: "feed" }>;
  assert.equal(result.etag, null);
  assert.equal(result.lastModified, null);
});

test("a non-2xx status is feed_http_error", async () => {
  for (const status of [301, 404, 500, 503]) {
    const h = harness(() => new Response("nope", { status }));
    const error = await rejection(
      fetchFeed({ publicFetch: h.publicFetch, feedUrl: URL_WITH_TOKEN }),
    );
    assert.equal(error.reason, "feed_http_error");
    assert.equal(error.code, "feed_http_error");
    assert.equal(h.state.closes, 1);
  }
});

test("a body of maxBytes + 1 is feed_too_large and the stream is cancelled", async () => {
  let cancelled = 0;
  const maxBytes = 10;
  const { stream } = trackedStream(
    [new Uint8Array(6), new Uint8Array(5), new Uint8Array(100)],
    { onCancel: () => (cancelled += 1) },
  );
  const h = harness(() => new Response(stream, { status: 200 }));
  const error = await rejection(
    fetchFeed({
      publicFetch: h.publicFetch,
      feedUrl: URL_WITH_TOKEN,
      maxBytes,
    }),
  );
  assert.equal(error.reason, "feed_too_large");
  assert.equal(cancelled, 1);
  assert.equal(h.state.closes, 1);
});

test("a body of exactly maxBytes is accepted", async () => {
  const h = harness(() => new Response("0123456789"));
  const result = (await fetchFeed({
    publicFetch: h.publicFetch,
    feedUrl: "https://h.example/feed",
    maxBytes: 10,
  })) as Extract<FeedFetchResult, { kind: "feed" }>;
  assert.equal(result.body, "0123456789");
});

test("a huge no-Content-Length body is cancelled, not fully read", async () => {
  let cancelled = 0;
  const chunk = new Uint8Array(1024);
  let produced = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      produced += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled += 1;
    },
  });
  const h = harness(() => new Response(stream, { status: 200 }));
  const error = await rejection(
    fetchFeed({
      publicFetch: h.publicFetch,
      feedUrl: "https://h.example/feed",
      maxBytes: 4096,
    }),
  );
  assert.equal(error.reason, "feed_too_large");
  assert.equal(cancelled, 1);
  // Unbounded source: reading stopped shortly after the cap, not at exhaustion.
  assert.ok(produced < 20, `produced ${produced} chunks`);
});

test("a large Content-Length rejects early without reading the body", async () => {
  let cancelled = 0;
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {
      cancelled += 1;
    },
  });
  const h = harness(
    () =>
      new Response(stream, {
        status: 200,
        headers: { "content-length": "999999999" },
      }),
  );
  const error = await rejection(
    fetchFeed({
      publicFetch: h.publicFetch,
      feedUrl: "https://h.example/feed",
      maxBytes: 1024,
    }),
  );
  assert.equal(error.reason, "feed_too_large");
  assert.equal(cancelled, 1);
  assert.ok(pulled <= 1, `pulled ${pulled}`);
  assert.equal(h.state.closes, 1);
});

test("a malformed Content-Length is ignored and the cap still applies while streaming", async () => {
  const h = harness(
    () =>
      new Response("x".repeat(50), {
        status: 200,
        headers: { "content-length": "abc" },
      }),
  );
  const error = await rejection(
    fetchFeed({
      publicFetch: h.publicFetch,
      feedUrl: "https://h.example/feed",
      maxBytes: 10,
    }),
  );
  assert.equal(error.reason, "feed_too_large");
});

test("a fetch that never resolves aborts at timeoutMs as feed_timeout", async () => {
  const h = harness(() => new Promise<Response>(() => undefined));
  const error = await rejection(
    fetchFeed({
      publicFetch: h.publicFetch,
      feedUrl: URL_WITH_TOKEN,
      timeoutMs: 20,
    }),
  );
  assert.equal(error.reason, "feed_timeout");
  assert.equal(h.state.closes, 1);
});

test("a fetch rejecting with an AbortError is feed_timeout", async () => {
  const h = harness((_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted", "AbortError"));
      });
    }),
  );
  const error = await rejection(
    fetchFeed({
      publicFetch: h.publicFetch,
      feedUrl: URL_WITH_TOKEN,
      timeoutMs: 20,
    }),
  );
  assert.equal(error.reason, "feed_timeout");
});

test("a body that stalls mid-stream aborts as feed_timeout and is cancelled", async () => {
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("<rss>"));
    },
    pull() {
      return new Promise<void>(() => undefined);
    },
    cancel() {
      cancelled += 1;
    },
  });
  const h = harness(() => new Response(stream, { status: 200 }));
  const error = await rejection(
    fetchFeed({
      publicFetch: h.publicFetch,
      feedUrl: URL_WITH_TOKEN,
      timeoutMs: 30,
    }),
  );
  assert.equal(error.reason, "feed_timeout");
  assert.equal(cancelled, 1);
  assert.equal(h.state.closes, 1);
});

test("an ENDPOINT_NOT_ALLOWED error is feed_blocked_address without its message", async () => {
  const h = harness(() => {
    throw Object.assign(new Error(`blocked ${URL_WITH_TOKEN} 10.0.0.1`), {
      code: "ENDPOINT_NOT_ALLOWED",
      reason: "host",
    });
  });
  const error = await rejection(
    fetchFeed({ publicFetch: h.publicFetch, feedUrl: URL_WITH_TOKEN }),
  );
  assert.equal(error.reason, "feed_blocked_address");
  assert.ok(!error.message.includes("10.0.0.1"));
  assert.equal(h.state.closes, 1);
});

test("a policy error object without Error prototype still maps", async () => {
  const h = harness(() =>
    Promise.reject({ code: "ENDPOINT_NOT_ALLOWED", reason: "host" }),
  );
  const error = await rejection(
    fetchFeed({ publicFetch: h.publicFetch, feedUrl: URL_WITH_TOKEN }),
  );
  assert.equal(error.reason, "feed_blocked_address");
});

test("any other failure is feed_unreachable with no cause", async () => {
  const h = harness(() => {
    throw new TypeError(`fetch failed ${URL_WITH_TOKEN}`, {
      cause: new Error("ECONNREFUSED"),
    });
  });
  const error = await rejection(
    fetchFeed({ publicFetch: h.publicFetch, feedUrl: URL_WITH_TOKEN }),
  );
  assert.equal(error.reason, "feed_unreachable");
  assert.equal(error.cause, undefined);
  assert.equal(h.state.closes, 1);
});

test("a body stream that errors is feed_unreachable", async () => {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error(`boom ${SENTINEL}`));
    },
  });
  const h = harness(() => new Response(stream, { status: 200 }));
  const error = await rejection(
    fetchFeed({ publicFetch: h.publicFetch, feedUrl: URL_WITH_TOKEN }),
  );
  assert.equal(error.reason, "feed_unreachable");
});

test("http:// and userinfo URLs reject before any scope or fetch", async () => {
  const h = harness(() => new Response("<rss/>"));
  const cases: [string, string][] = [
    ["http://h.example/feed", "feed_https_required"],
    ["https://user:pw@h.example/feed", "feed_credentials_not_allowed"],
    ["not a url", "feed_url_invalid"],
  ];
  for (const [feedUrl, reason] of cases) {
    const error = await rejection(
      fetchFeed({ publicFetch: h.publicFetch, feedUrl }),
    );
    assert.equal(error.reason, reason);
  }
  assert.equal(h.state.fetchCalls, 0);
  assert.equal(h.state.scopes, 0);
});

test("each call opens its own scope and closes it exactly once on every path", async () => {
  const h = harness((url, init) => {
    void url;
    void init;
    return new Response("<rss/>");
  });
  await fetchFeed({ publicFetch: h.publicFetch, feedUrl: "https://h.example/a" });
  await fetchFeed({ publicFetch: h.publicFetch, feedUrl: "https://h.example/b" });
  assert.equal(h.state.scopes, 2);
  assert.equal(h.state.closes, 2);
});

test("a close() that throws does not replace the result", async () => {
  const publicFetch = (): ConnectorPublicFetchScope => ({
    fetch: (async () => new Response("<rss/>")) as typeof fetch,
    close: async () => {
      throw new Error(`close failed ${SENTINEL}`);
    },
  });
  const result = await fetchFeed({
    publicFetch,
    feedUrl: "https://h.example/feed",
  });
  assert.equal(result.kind, "feed");
});

test("sentinel token never appears in any error, string form, JSON or logger call", async () => {
  // fetchFeed takes no logger; assert it writes nothing to the console either.
  const logged: unknown[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = { ...console };
  for (const m of methods) {
    console[m] = (...args: unknown[]) => void logged.push(args);
  }
  try {
    await runSentinelScenarios(logged);
  } finally {
    for (const m of methods) console[m] = originals[m];
  }
});

async function runSentinelScenarios(logged: unknown[]) {
  const leaky = (label: string) =>
    new Error(`${label} ${URL_WITH_TOKEN} ${SENTINEL}`, {
      cause: new Error(SENTINEL),
    });
  const scenarios: [string, Handler, { timeoutMs?: number; maxBytes?: number }][] = [
    ["blocked", () => { throw Object.assign(leaky("policy"), { code: "ENDPOINT_NOT_ALLOWED", reason: "host" }); }, {}],
    ["timeout", () => new Promise<Response>(() => undefined), { timeoutMs: 20 }],
    ["too_large", () => new Response("x".repeat(100)), { maxBytes: 10 }],
    ["http_error", () => new Response("x", { status: 500 }), {}],
    ["unreachable", () => { throw leaky("fetch failed"); }, {}],
  ];
  const errors: RssAdapterError[] = [];
  for (const [, handler, extra] of scenarios) {
    const h = harness(handler);
    errors.push(
      await rejection(
        fetchFeed({ publicFetch: h.publicFetch, feedUrl: URL_WITH_TOKEN, ...extra }),
      ),
    );
  }
  for (const feedUrl of [
    `http://h.example/feed?token=${SENTINEL}`,
    `https://u:p@h.example/feed?token=${SENTINEL}`,
  ]) {
    const h = harness(() => new Response("x"));
    errors.push(await rejection(fetchFeed({ publicFetch: h.publicFetch, feedUrl })));
  }
  assert.deepEqual(
    errors.map((e) => e.reason),
    [
      "feed_blocked_address",
      "feed_timeout",
      "feed_too_large",
      "feed_http_error",
      "feed_unreachable",
      "feed_https_required",
      "feed_credentials_not_allowed",
    ],
  );
  for (const error of errors) {
    assert.ok(!error.message.includes(SENTINEL));
    assert.ok(!String(error).includes(SENTINEL));
    assert.ok(!JSON.stringify(error).includes(SENTINEL));
    assert.ok(!(error.stack ?? "").includes(SENTINEL));
    assert.equal(error.cause, undefined);
    assert.ok(!error.message.includes("h.example"));
  }
  assert.equal(JSON.stringify(logged).includes(SENTINEL), false);
}

test("every reason has a fixed message, status code and matching code", () => {
  const reasons = [
    "feed_blocked_address",
    "feed_timeout",
    "feed_too_large",
    "feed_not_a_feed",
    "feed_http_error",
    "feed_unreachable",
    "feed_url_invalid",
    "feed_https_required",
    "feed_credentials_not_allowed",
  ] as const;
  const messages = new Set<string>();
  for (const reason of reasons) {
    const error = new RssAdapterError(reason);
    assert.equal(error.code, reason);
    assert.equal(error.reason, reason);
    assert.ok(error.statusCode >= 400 && error.statusCode < 600);
    assert.ok(!error.message.includes(SENTINEL));
    messages.add(error.message);
  }
  assert.equal(messages.size, reasons.length);
});
