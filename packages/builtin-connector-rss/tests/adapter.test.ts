import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isConnectorItemSkipError,
  type ConnectorDiscoverInput,
  type ConnectorDiscoveryPage,
  type ConnectorItem,
} from "@sourceweft/contracts";
import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";
import { createRssConnectorAdapter } from "../src/adapter";
import { toBackendRssManifest } from "../src/backend-manifest";
import { RssAdapterError } from "../src/errors";

const SENTINEL = "SECRET-TOKEN-123";
const FEED_URL = `https://h.example/feed?token=${SENTINEL}`;

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

type Recorded = { url: string; headers: Headers };
type Handler = (request: Recorded) => Promise<Response> | Response;

function harness(handler: Handler) {
  const requests: Recorded[] = [];
  const state = { scopes: 0, closes: 0 };
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> =
    [];
  const publicFetch = (): ConnectorPublicFetchScope => {
    state.scopes += 1;
    return {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const recorded = {
          url: String(input),
          headers: new Headers(init?.headers),
        };
        requests.push(recorded);
        return handler(recorded);
      }) as typeof fetch,
      close: async () => {
        state.closes += 1;
      },
    };
  };
  const logger = {
    warn(message: string, meta?: Record<string, unknown>) {
      warnings.push({ message, meta });
    },
  };
  return { publicFetch, logger, requests, state, warnings };
}

const feedResponse = (
  body: string,
  headers: Record<string, string> = {
    etag: '"v1"',
    "last-modified": "Wed, 05 Nov 2025 09:00:00 GMT",
  },
): Response => new Response(body, { status: 200, headers });

function input(
  feedUrl: string = FEED_URL,
  extra: Partial<ConnectorDiscoverInput> = {},
): ConnectorDiscoverInput {
  return {
    teamId: "t",
    workspaceId: "w",
    connectorId: "c1",
    connectorType: "rss",
    config: { feedUrl },
    accessToken: "",
    ...extra,
  };
}

async function collect(
  iterable: AsyncIterable<ConnectorDiscoveryPage>,
): Promise<ConnectorDiscoveryPage[]> {
  const pages: ConnectorDiscoveryPage[] = [];
  for await (const page of iterable) pages.push(page);
  return pages;
}

function bigFeed(count: number, suffix = ""): string {
  const items = Array.from(
    { length: count },
    (_, i) =>
      `<item><title>Item ${i}</title><guid>g-${i}</guid><link>https://example.com/${i}</link><description>Body ${i}${suffix}</description></item>`,
  ).join("");
  return `<rss version="2.0"><channel><title>Big</title>${items}</channel></rss>`;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected rejection");
}

test("manifest is the backend RSS manifest and has no OAuth methods", () => {
  const h = harness(() => feedResponse(fixture("rss2.xml")));
  const adapter = createRssConnectorAdapter({ publicFetch: h.publicFetch });
  assert.deepEqual(adapter.getManifest(), toBackendRssManifest());
  assert.equal(adapter.getManifest().auth.kind, "none");
  assert.equal(adapter.exchangeOAuthCode, undefined);
  assert.equal(adapter.refreshOAuthToken, undefined);
});

test("readiness ok returns title and item count", async () => {
  const h = harness(() => feedResponse(fixture("rss2.xml")));
  const adapter = createRssConnectorAdapter({ publicFetch: h.publicFetch });
  const result = await adapter.checkSyncReadiness!(input());
  assert.deepEqual(result, {
    ready: true,
    metadata: { title: "Example Feed", itemCount: 2 },
  });
  assert.equal(h.requests.length, 1);
  assert.equal(h.state.closes, 1);
});

test("each failure reason is a not-ready result with a fixed message and no URL", async () => {
  const cases: Array<{
    reason: string;
    feedUrl?: string;
    handler?: Handler;
    limits?: { timeoutMs?: number; maxBytes?: number };
  }> = [
    { reason: "feed_url_invalid", feedUrl: "not a url" },
    {
      reason: "feed_https_required",
      feedUrl: `http://h.example/feed?token=${SENTINEL}`,
    },
    {
      reason: "feed_credentials_not_allowed",
      feedUrl: `https://u:p@h.example/feed?token=${SENTINEL}`,
    },
    {
      reason: "feed_blocked_address",
      handler: () => {
        throw Object.assign(new Error(`blocked ${FEED_URL}`), {
          code: "ENDPOINT_NOT_ALLOWED",
        });
      },
    },
    {
      reason: "feed_timeout",
      handler: () => new Promise<Response>(() => {}),
      limits: { timeoutMs: 20 },
    },
    {
      reason: "feed_too_large",
      handler: () => feedResponse(fixture("rss2.xml")),
      limits: { maxBytes: 10 },
    },
    {
      reason: "feed_not_a_feed",
      handler: () => feedResponse(fixture("html-page.html")),
    },
    {
      reason: "feed_http_error",
      handler: () => new Response("nope", { status: 500 }),
    },
    {
      reason: "feed_unreachable",
      handler: () => {
        throw new Error(`connect failed ${FEED_URL}`);
      },
    },
  ];
  for (const c of cases) {
    const h = harness(c.handler ?? (() => feedResponse("<rss/>")));
    const adapter = createRssConnectorAdapter({
      publicFetch: h.publicFetch,
      logger: h.logger,
      limits: c.limits,
    });
    const result = await adapter.checkSyncReadiness!(
      input(c.feedUrl ?? FEED_URL),
    );
    assert.equal(result.ready, false, c.reason);
    assert.equal(result.reason, c.reason);
    assert.ok(result.message && result.message.length > 0, c.reason);
    assert.ok(!result.message.includes(SENTINEL), c.reason);
    assert.ok(!JSON.stringify(h.warnings).includes(SENTINEL), c.reason);
  }
});

test("first discoverPages yields one complete page in document order with hashes and validators", async () => {
  const h = harness(() => feedResponse(fixture("rss2.xml")));
  const adapter = createRssConnectorAdapter({ publicFetch: h.publicFetch });
  const pages = await collect(adapter.discoverPages!(input()));
  assert.equal(pages.length, 1);
  const page = pages[0]!;
  assert.equal(page.complete, true);
  assert.deepEqual(page.checkpoint, {
    etag: '"v1"',
    lastModified: "Wed, 05 Nov 2025 09:00:00 GMT",
  });
  assert.deepEqual(
    page.items.map((i) => i.externalId),
    ["post-1", "https://example.com/posts/2"],
  );
  const first = page.items[0]!;
  assert.equal(first.title, "First & foremost");
  assert.equal(first.mimeType, "text/plain");
  assert.equal(first.externalUri, "https://example.com/posts/1?id=1");
  assert.equal(
    first.sizeBytes,
    Buffer.byteLength("Full body text\n\nSecond paragraph"),
  );
  assert.deepEqual(first.externalUpdatedAt, new Date("2025-11-03T10:00:00Z"));
  assert.match(first.contentHash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(first.metadata.feedTitle, "Example Feed");
  assert.equal(first.metadata.feedHost, "h.example");
  assert.equal(first.metadata.author, "Ada Lovelace");
  assert.equal(first.metadata.publishedAt, "2025-11-03T10:00:00.000Z");
  assert.equal(first.metadata.url, "https://example.com/posts/1?id=1");
  assert.equal(typeof first.metadata.citationKey, "string");
  assert.ok(!("feedUrl" in first.metadata));
});

test("second call sends validators and a 304 yields no items, the same checkpoint, no reconcile", async () => {
  let calls = 0;
  const h = harness((request) => {
    calls += 1;
    if (calls === 1) return feedResponse(fixture("rss2.xml"));
    assert.equal(request.headers.get("if-none-match"), '"v1"');
    assert.equal(
      request.headers.get("if-modified-since"),
      "Wed, 05 Nov 2025 09:00:00 GMT",
    );
    return new Response(null, { status: 304 });
  });
  const adapter = createRssConnectorAdapter({ publicFetch: h.publicFetch });
  const [first] = await collect(adapter.discoverPages!(input()));
  const [second] = await collect(
    adapter.discoverPages!(
      input(FEED_URL, {
        cursor: { committed: first!.checkpoint, continuation: null },
      }),
    ),
  );
  assert.deepEqual(second, {
    items: [],
    complete: true,
    checkpoint: first!.checkpoint,
    reconcileMissing: false,
  });
  assert.equal(h.state.scopes, 2);
  assert.equal(h.state.closes, 2);
});

test("a first-page result is authoritative only as a non-reconciling scan", async () => {
  const h = harness(() => feedResponse(fixture("rss2.xml")));
  const adapter = createRssConnectorAdapter({ publicFetch: h.publicFetch });
  const [page] = await collect(adapter.discoverPages!(input()));
  assert.notEqual(page!.reconcileMissing, true);
});

test("a feed with 600 items yields 500 and logs a truncation warning without the URL", async () => {
  const h = harness(() => feedResponse(bigFeed(600)));
  const adapter = createRssConnectorAdapter({
    publicFetch: h.publicFetch,
    logger: h.logger,
  });
  const [page] = await collect(adapter.discoverPages!(input()));
  assert.equal(page!.items.length, 500);
  assert.deepEqual(h.warnings, [
    {
      message: "rss_feed_truncated",
      meta: { feedHost: "h.example", kept: 500 },
    },
  ]);
});

test("re-discovering the same feed yields identical ids and hashes; a changed item changes only its hash", async () => {
  let changed = "";
  const h = harness(() =>
    feedResponse(bigFeed(3).replace("Body 1", `Body 1${changed}`)),
  );
  const adapter = createRssConnectorAdapter({ publicFetch: h.publicFetch });
  const [a] = await collect(adapter.discoverPages!(input()));
  const [b] = await collect(adapter.discoverPages!(input()));
  assert.deepEqual(
    b!.items.map((i) => [i.externalId, i.contentHash]),
    a!.items.map((i) => [i.externalId, i.contentHash]),
  );
  changed = " edited";
  const [c] = await collect(adapter.discoverPages!(input()));
  assert.deepEqual(
    c!.items.map((i) => i.externalId),
    a!.items.map((i) => i.externalId),
  );
  const diff = c!.items
    .filter((item, i) => item.contentHash !== a!.items[i]!.contentHash)
    .map((i) => i.externalId);
  assert.deepEqual(diff, ["g-1"]);
});

test("discover yields the same items without validators", async () => {
  const h = harness(() => feedResponse(fixture("rss2.xml")));
  const adapter = createRssConnectorAdapter({ publicFetch: h.publicFetch });
  const items: ConnectorItem[] = [];
  for await (const item of adapter.discover(
    input(FEED_URL, { cursor: { committed: { etag: '"v1"' } } }),
  )) {
    items.push(item);
  }
  assert.equal(items.length, 2);
  assert.equal(h.requests[0]!.headers.get("if-none-match"), null);
});

test("extract after discoverPages makes no extra fetch; after a cold start it refetches once", async () => {
  const h = harness(() => feedResponse(fixture("rss2.xml")));
  const adapter = createRssConnectorAdapter({ publicFetch: h.publicFetch });
  const [page] = await collect(adapter.discoverPages!(input()));
  assert.equal(h.requests.length, 1);
  const extracted = await adapter.extract({
    ...input(),
    item: page!.items[0]!,
  });
  assert.equal(h.requests.length, 1);
  assert.ok("contentText" in extracted);
  assert.equal(
    (extracted as { contentText: string }).contentText,
    "Full body text\n\nSecond paragraph",
  );
  assert.equal(extracted.item.externalId, "post-1");

  const cold = createRssConnectorAdapter({ publicFetch: h.publicFetch });
  const again = await cold.extract({ ...input(), item: page!.items[1]! });
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1]!.headers.get("if-none-match"), null);
  assert.equal(again.item.externalId, "https://example.com/posts/2");
});

test("extract cache expires after ten minutes and holds at most 50 connectors", async () => {
  let now = 1_000_000;
  const h = harness(() => feedResponse(fixture("rss2.xml")));
  const adapter = createRssConnectorAdapter({
    publicFetch: h.publicFetch,
    now: () => now,
  });
  const [page] = await collect(adapter.discoverPages!(input()));
  now += 9 * 60_000;
  await adapter.extract({ ...input(), item: page!.items[0]! });
  assert.equal(h.requests.length, 1);
  now += 2 * 60_000;
  await adapter.extract({ ...input(), item: page!.items[0]! });
  assert.equal(h.requests.length, 2);

  // 51 connectors: the oldest is evicted.
  const h2 = harness(() => feedResponse(fixture("rss2.xml")));
  const adapter2 = createRssConnectorAdapter({ publicFetch: h2.publicFetch });
  let firstItem: ConnectorItem | undefined;
  for (let i = 0; i < 51; i += 1) {
    const [p] = await collect(
      adapter2.discoverPages!(input(FEED_URL, { connectorId: `c${i}` })),
    );
    if (i === 0) firstItem = p!.items[0];
  }
  assert.equal(h2.requests.length, 51);
  await adapter2.extract({
    ...input(FEED_URL, { connectorId: "c50" }),
    item: firstItem!,
  });
  assert.equal(h2.requests.length, 51);
  await adapter2.extract({
    ...input(FEED_URL, { connectorId: "c0" }),
    item: firstItem!,
  });
  assert.equal(h2.requests.length, 52);
});

test("extract skips an item with an empty body and an item missing from the feed", async () => {
  const xml = `<rss version="2.0"><channel><title>T</title><item><title>Empty</title><guid>e1</guid></item></channel></rss>`;
  const h = harness(() => feedResponse(xml));
  const adapter = createRssConnectorAdapter({ publicFetch: h.publicFetch });
  const [page] = await collect(adapter.discoverPages!(input()));
  const empty = await rejection(
    adapter.extract({ ...input(), item: page!.items[0]! }),
  );
  assert.ok(isConnectorItemSkipError(empty));
  assert.equal(empty.reason, "empty_content");

  const missing = await rejection(
    adapter.extract({
      ...input(),
      item: { ...page!.items[0]!, externalId: "gone" },
    }),
  );
  assert.ok(isConnectorItemSkipError(missing));
  assert.equal(missing.reason, "unreadable");
});

test("item uri, metadata, errors and logs never carry the feed URL token", async () => {
  const h = harness(() => feedResponse(bigFeed(501)));
  const adapter = createRssConnectorAdapter({
    publicFetch: h.publicFetch,
    logger: h.logger,
  });
  const [page] = await collect(adapter.discoverPages!(input()));
  for (const item of page!.items) {
    assert.ok(!JSON.stringify(item).includes(SENTINEL));
    assert.ok(!(item.externalUri ?? "").includes(SENTINEL));
    assert.equal(item.metadata.feedHost, "h.example");
  }
  assert.ok(!JSON.stringify(h.warnings).includes(SENTINEL));

  const failing = harness(() => {
    throw new Error(`boom ${FEED_URL}`);
  });
  const failingAdapter = createRssConnectorAdapter({
    publicFetch: failing.publicFetch,
    logger: failing.logger,
  });
  const error = await rejection(
    collect(failingAdapter.discoverPages!(input())),
  );
  assert.ok(error instanceof RssAdapterError);
  assert.ok(!error.message.includes(SENTINEL));
  assert.ok(!JSON.stringify(failing.warnings).includes(SENTINEL));
});

test("a feed that is not a feed surfaces as feed_not_a_feed", async () => {
  const h = harness(() => feedResponse(fixture("entity-bomb.xml")));
  const adapter = createRssConnectorAdapter({ publicFetch: h.publicFetch });
  const error = await rejection(collect(adapter.discoverPages!(input())));
  assert.ok(error instanceof RssAdapterError);
  assert.equal(error.reason, "feed_not_a_feed");
  assert.equal(error.statusCode, 422);
});

test("discoverPages on a blocked-address redirect rejects with feed_blocked_address", async () => {
  const h = harness(() => {
    throw Object.assign(new Error("policy"), { code: "ENDPOINT_NOT_ALLOWED" });
  });
  const adapter = createRssConnectorAdapter({ publicFetch: h.publicFetch });
  const error = await rejection(collect(adapter.discoverPages!(input())));
  assert.ok(error instanceof RssAdapterError);
  assert.equal(error.reason, "feed_blocked_address");
  assert.equal(h.state.closes, 1);
});

test("a config without a feedUrl is rejected as an invalid URL", async () => {
  const h = harness(() => feedResponse(fixture("rss2.xml")));
  const adapter = createRssConnectorAdapter({ publicFetch: h.publicFetch });
  const result = await adapter.checkSyncReadiness!({ ...input(), config: {} });
  assert.equal(result.ready, false);
  assert.equal(result.reason, "feed_url_invalid");
  assert.equal(h.requests.length, 0);
});

test("executeAction rejects with RSS_ACTIONS_UNSUPPORTED", async () => {
  const h = harness(() => feedResponse(fixture("rss2.xml")));
  const adapter = createRssConnectorAdapter({ publicFetch: h.publicFetch });
  const error = await rejection(
    adapter.executeAction({
      teamId: "t",
      workspaceId: "w",
      connectorId: "c1",
      connectorType: "rss",
      actionType: "rss.anything",
      request: {},
      config: { feedUrl: FEED_URL },
      accessToken: "",
      idempotencyKey: "k",
    }),
  );
  assert.ok(error instanceof RssAdapterError);
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, "RSS_ACTIONS_UNSUPPORTED");
});
