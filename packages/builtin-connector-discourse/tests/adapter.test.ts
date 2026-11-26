import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorItemSkipError,
  type ConnectorDiscoveryPage,
} from "@sourceweft/contracts";
import { createDiscourseAdapter, DiscourseAdapterError } from "../src/adapter";
import {
  adapterForum,
  baseInput,
  FORUM_URL,
  forumConfig,
  harness,
} from "./helpers/adapter-fixtures";

const sel = (...ids: string[]) =>
  ids.map((id) => ({ id, kind: id.split(":")[0] as string }));

test("the adapter identifies itself and has no OAuth, webhook or credential surface", () => {
  const { adapter } = harness(adapterForum());
  assert.equal(adapter.capabilityId, "sourceweft/discourse");
  assert.equal(adapter.getManifest().type, "discourse");
  for (const absent of [
    "exchangeOAuthCode",
    "refreshOAuthToken",
    "credentialFlow",
    "credentialIdentity",
    "revokeAuthorization",
    "startAuthorization",
    "finishAuthorization",
    "verifyWebhook",
    "parseWebhookEvent",
    "mapWebhookEventToSyncTargets",
  ] as const) {
    assert.equal(absent in adapter, false, absent);
  }
});

// ---- readiness -----------------------------------------------------------

test("readiness: a reachable forum with a selection is ready and reports the public category count", async () => {
  const h = harness(adapterForum());
  const result = await h.adapter.checkSyncReadiness!(
    baseInput(forumConfig(sel("category:10"))),
  );
  // 6 categories, of which Staff (12) and its child (14) are restricted.
  assert.deepEqual(result, { ready: true, metadata: { categoryCount: 4 } });
  assert.equal(h.opened(), 1);
  assert.equal(h.closed(), 1);
});

test("readiness: an invalid config is config_invalid without any request", async () => {
  const h = harness(adapterForum());
  for (const config of [
    { items: sel("category:10") },
    { forumUrl: "http://forum.example.com", items: sel("category:10") },
    { forumUrl: "https://localhost", items: sel("category:10") },
    forumConfig([{ id: "topic:5", kind: "category" }]),
  ]) {
    const result = await h.adapter.checkSyncReadiness!(baseInput(config));
    assert.equal(result.ready, false);
    assert.equal(result.reason, "config_invalid");
    assert.equal(typeof result.message, "string");
  }
  assert.equal(h.fake.requests.length, 0);
  assert.equal(h.closed(), h.opened());
});

test("readiness: an empty selection is selection_required without any request", async () => {
  const h = harness(adapterForum());
  for (const config of [forumConfig([]), { forumUrl: FORUM_URL }]) {
    const result = await h.adapter.checkSyncReadiness!(baseInput(config));
    assert.equal(result.ready, false);
    assert.equal(result.reason, "selection_required");
  }
  assert.equal(h.fake.requests.length, 0);
});

test("readiness: every site() failure maps to its reason", async () => {
  const config = baseInput(forumConfig(sel("topic:1")));
  const cases: Array<[string, (h: ReturnType<typeof harness>) => void]> = [
    ["login_required", (h) => h.fake.failNext({ status: 403, body: "{}" }, 1)],
    ["not_a_discourse_site", (h) => h.fake.failNext({ status: 404 }, 1)],
    ["forum_unreachable", (h) => h.fake.failNext({ status: 500 }, 1)],
    ["forum_unreachable", (h) => h.fake.failNext({ networkError: true }, 5)],
    [
      "rate_limited",
      (h) =>
        h.fake.failNext({ status: 429, headers: { "retry-after": "0" } }, 5),
    ],
    [
      "not_a_discourse_site",
      (h) => h.fake.failNext({ status: 200, body: "<html>" }, 1),
    ],
  ];
  for (const [reason, arrange] of cases) {
    const h = harness(adapterForum(), {
      limits: { maxRetryDelayMs: 0 },
    });
    arrange(h);
    const result = await h.adapter.checkSyncReadiness!(config);
    assert.equal(result.ready, false, reason);
    assert.equal(result.reason, reason);
    assert.ok(result.message && !result.message.includes("example.com"));
    assert.equal(h.closed(), h.opened());
  }
});

test("readiness: a blocked endpoint maps to blocked_endpoint", async () => {
  let closed = 0;
  const adapter = createDiscourseAdapter({
    publicFetch: () => ({
      fetch: (async () => {
        throw Object.assign(new Error("blocked"), {
          code: "ENDPOINT_NOT_ALLOWED",
        });
      }) as unknown as typeof fetch,
      close: async () => {
        closed += 1;
      },
    }),
    limits: { minRequestGapMs: 0 },
  });
  const result = await adapter.checkSyncReadiness!(
    baseInput(forumConfig(sel("topic:1"))),
  );
  assert.equal(result.reason, "blocked_endpoint");
  assert.equal(closed, 1);
});

test("readiness: a forum that requires login is login_required", async () => {
  const forum = { ...adapterForum(), loginRequired: true };
  const h = harness(forum);
  const result = await h.adapter.checkSyncReadiness!(
    baseInput(forumConfig(sel("topic:1"))),
  );
  assert.equal(result.reason, "login_required");
});

// ---- config validation (through discoverPages) -----------------------------

async function discoverError(
  h: ReturnType<typeof harness>,
  config: Record<string, unknown>,
) {
  try {
    for await (const _page of h.adapter.discoverPages!(baseInput(config))) {
      void _page;
    }
  } catch (error) {
    return error;
  }
  return null;
}

test("config validation rejects every malformed shape before any request", async () => {
  const dup = sel("category:10", "category:10");
  const many = Array.from({ length: 501 }, (_, i) => ({
    id: `topic:${i + 1}`,
    kind: "topic",
  }));
  const cases: Array<Record<string, unknown>> = [
    forumConfig([{ id: "topic:5", kind: "category" }]),
    forumConfig([{ id: "category:5", kind: "topic" }]),
    forumConfig([{ id: "5", kind: "topic" }]),
    forumConfig([{ id: "topic:0", kind: "topic" }]),
    forumConfig([{ id: "topic:01", kind: "topic" }]),
    forumConfig([{ id: "topic:12345678901", kind: "topic" }]),
    forumConfig([{ id: "forum:5", kind: "forum" }]),
    forumConfig(dup),
    forumConfig(many),
    forumConfig(sel("topic:1"), { refresh: "weekly" }),
    forumConfig(sel("topic:1"), { refresh: 1 }),
    { ...forumConfig(sel("topic:1")), forumUrl: "http://forum.example.com" },
    { ...forumConfig(sel("topic:1")), forumUrl: "https://10.0.0.1" },
    {
      ...forumConfig(sel("topic:1")),
      forumUrl: "https://forum.example.com:8443",
    },
    { ...forumConfig(sel("topic:1")), forumUrl: 5 },
    { items: sel("topic:1") },
    { forumUrl: FORUM_URL, items: "topic:1" },
    { forumUrl: FORUM_URL, items: [null] },
    { forumUrl: FORUM_URL, items: [{ id: 5, kind: "topic" }] },
  ];
  for (const config of cases) {
    const h = harness(adapterForum());
    const error = await discoverError(h, config);
    assert.ok(error instanceof DiscourseAdapterError, JSON.stringify(config));
    assert.equal(error.code, "DISCOURSE_CONFIG_INVALID");
    assert.equal(error.statusCode, 400);
    assert.equal(h.fake.requests.length, 0);
    assert.equal(h.closed(), h.opened());
  }
});

test("config validation accepts the boundaries: 500 items, either refresh, a subfolder and a trailing slash", async () => {
  const items = Array.from({ length: 500 }, (_, i) => ({
    id: `topic:${i + 1}`,
    kind: "topic",
  }));
  const h = harness(adapterForum(), { limits: { MAX_REQUESTS: 3 } });
  // 500 topic reads blow the scan's request cap, which is a non-reconciling
  // empty page, not a config error.
  const pages: ConnectorDiscoveryPage[] = [];
  for await (const page of h.adapter.discoverPages!(
    baseInput(forumConfig(items)),
  )) {
    pages.push(page);
  }
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.reconcileMissing, false);

  const trailing = harness(adapterForum());
  const result = await trailing.adapter.checkSyncReadiness!(
    baseInput({
      forumUrl: `${FORUM_URL}/`,
      items: sel("topic:1"),
      refresh: "deep",
    }),
  );
  assert.equal(result.ready, true);
});

// ---- discovery and extraction ----------------------------------------------

test("discoverPages scans the selection with the config's refresh mode", async () => {
  const h = harness(adapterForum({ topics: 3 }));
  const pages: ConnectorDiscoveryPage[] = [];
  for await (const page of h.adapter.discoverPages!(
    baseInput(forumConfig(sel("category:10"))),
  )) {
    pages.push(page);
  }
  assert.equal(pages.length, 1);
  const page = pages[0]!;
  assert.equal(page.complete, true);
  assert.equal(page.reconcileMissing, true);
  // Light: no topic document is read. 3 in category 10 + 901 in subcategory 11.
  assert.equal(page.items.length, 4);
  assert.ok(
    !h.fake.requests.some((r) => /\/t\/\d+\.json$/.test(r.path)),
    "light refresh reads no topic document",
  );
  assert.equal(h.opened(), 1);
  assert.equal(h.closed(), 1);

  const deep = harness(adapterForum({ topics: 2 }));
  const deepPages: ConnectorDiscoveryPage[] = [];
  for await (const page of deep.adapter.discoverPages!(
    baseInput(forumConfig(sel("category:10"), { refresh: "deep" })),
  )) {
    deepPages.push(page);
  }
  assert.equal(deepPages[0]!.items.length, 3);
  assert.ok(deep.fake.requests.some((r) => /\/t\/\d+\.json$/.test(r.path)));
});

test("discover yields the items of the scan", async () => {
  const h = harness(adapterForum({ topics: 2 }));
  const items = [];
  for await (const item of h.adapter.discover(
    baseInput(forumConfig(sel("category:10"))),
  )) {
    items.push(item);
  }
  assert.equal(items.length, 3);
  assert.equal(h.closed(), h.opened());
});

test("discoverPages with an empty selection never reaches the network", async () => {
  const h = harness(adapterForum());
  const error = await discoverError(h, forumConfig([]));
  assert.ok(error instanceof DiscourseAdapterError);
  assert.equal(error.code, "DISCOURSE_SELECTION_REQUIRED");
  assert.equal(h.fake.requests.length, 0);
});

test("a discovery failure crosses the boundary as a DiscourseAdapterError with a fixed message", async () => {
  const h = harness({ ...adapterForum(), loginRequired: true });
  const error = await discoverError(h, forumConfig(sel("category:10")));
  assert.ok(error instanceof DiscourseAdapterError);
  assert.equal(error.code, "DISCOURSE_LOGIN_REQUIRED");
  assert.equal(error.statusCode, 422);
  assert.ok(!error.message.includes("example.com"));
  assert.equal(error.cause, undefined);
  assert.equal(h.closed(), h.opened());
});

test("extract renders a topic and skips one that vanished", async () => {
  const h = harness(adapterForum({ topics: 2 }));
  const pages: ConnectorDiscoveryPage[] = [];
  for await (const page of h.adapter.discoverPages!(
    baseInput(forumConfig(sel("topic:1"))),
  )) {
    pages.push(page);
  }
  const item = pages[0]!.items[0]!;
  const extracted = await h.adapter.extract({
    ...baseInput(forumConfig(sel("topic:1"))),
    item,
  });
  assert.ok("contentText" in extracted);
  assert.match(extracted.contentText, /Hello from topic 1/);
  assert.equal(h.closed(), h.opened());

  const gone = harness({
    ...adapterForum({ topics: 2 }),
    topics: adapterForum({ topics: 2 }).topics.map((t) =>
      t.id === 1 ? { ...t, gone: true } : t,
    ),
  });
  await assert.rejects(
    () =>
      gone.adapter.extract({
        ...baseInput(forumConfig(sel("topic:1"))),
        item,
      }),
    (error: unknown) => error instanceof ConnectorItemSkipError,
  );
  assert.equal(gone.closed(), gone.opened());
});

test("extract in deep mode uses the config's refresh", async () => {
  const h = harness(adapterForum({ topics: 1 }));
  const config = forumConfig(sel("topic:1"), { refresh: "deep" });
  const pages: ConnectorDiscoveryPage[] = [];
  for await (const page of h.adapter.discoverPages!(baseInput(config))) {
    pages.push(page);
  }
  const item = pages[0]!.items[0]!;
  const extracted = await h.adapter.extract({ ...baseInput(config), item });
  assert.equal(extracted.item.contentHash, item.contentHash);
});

test("an unsupported action is a fixed 400", async () => {
  const h = harness(adapterForum());
  await assert.rejects(
    () =>
      h.adapter.executeAction({
        ...baseInput(),
        actionType: "discourse.unknown",
        request: {},
        idempotencyKey: "k",
      }),
    (error: unknown) =>
      error instanceof DiscourseAdapterError &&
      error.statusCode === 400 &&
      error.code === "DISCOURSE_UNSUPPORTED_ACTION",
  );
  assert.equal(h.opened(), 0);
});

// ---- scope discipline -------------------------------------------------------

test("every operation opens exactly one scope and closes it on success, failure and early return", async () => {
  // success: covered by the tests above; here the failure and early-return paths.
  const failing = harness({ ...adapterForum(), loginRequired: true });
  await assert.rejects(() =>
    failing.adapter.extract({
      ...baseInput(forumConfig(sel("topic:1"))),
      item: {
        externalId: "x",
        externalUri: null,
        title: "t",
        mimeType: "text/markdown",
        sizeBytes: 1,
        externalUpdatedAt: null,
        contentHash: "h",
        metadata: { topicId: 1 },
      },
    }),
  );
  assert.equal(failing.opened(), 1);
  assert.equal(failing.closed(), 1);

  const early = harness(adapterForum());
  const generator = early.adapter.discoverPages!(
    baseInput(forumConfig(sel("category:10"))),
  )[Symbol.asyncIterator]();
  const first = await generator.next();
  assert.equal(first.done, false);
  await generator.return?.(undefined);
  assert.equal(early.opened(), 1);
  assert.equal(early.closed(), 1);

  const unstarted = harness(adapterForum());
  const idle = unstarted.adapter.discoverPages!(
    baseInput(forumConfig(sel("category:10"))),
  )[Symbol.asyncIterator]();
  await idle.return?.(undefined);
  assert.equal(unstarted.opened(), unstarted.closed());

  const discover = harness(adapterForum({ topics: 3 }));
  for await (const _item of discover.adapter.discover(
    baseInput(forumConfig(sel("category:10"))),
  )) {
    void _item;
    break;
  }
  assert.equal(discover.opened(), discover.closed());
});

test("each operation gets a fresh scope and a fresh client", async () => {
  const h = harness(adapterForum({ topics: 1 }), {
    limits: { maxRequests: 3 },
  });
  // Each readiness check spends 1 request; a shared client would run dry.
  for (let i = 0; i < 10; i += 1) {
    const result = await h.adapter.checkSyncReadiness!(
      baseInput(forumConfig(sel("topic:1"))),
    );
    assert.equal(result.ready, true);
  }
  assert.equal(h.opened(), 10);
  assert.equal(h.closed(), 10);
  // and a scan after them still has a full budget
  const pages: ConnectorDiscoveryPage[] = [];
  for await (const page of h.adapter.discoverPages!(
    baseInput(forumConfig(sel("category:10"))),
  )) {
    pages.push(page);
  }
  assert.equal(pages[0]!.reconcileMissing, true);
  assert.equal(pages[0]!.items.length, 2);
});
