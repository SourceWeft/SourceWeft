import assert from "node:assert/strict";
import test from "node:test";
import { createGhostClient, type ClientLimits } from "../src/client";
import { GhostError, type GhostErrorCode } from "../src/errors";
import { ID_BATCH, MAX_SCAN_RESTARTS } from "../src/limits";
import {
  scanSite,
  SCAN_NARROW_WARNING,
  SCAN_UNSTABLE_WARNING,
  type ScanLimits,
} from "../src/scan";
import type { SelectionItem } from "../src/selection-scope";
import {
  createFakeGhost,
  DEFAULT_KEY,
  hexId,
  sampleState,
  type FakeGhost,
  type FakeItem,
} from "./helpers/fake-ghost";

const SITE = "https://site.example";
const HOST = "site.example";

type Harness = {
  fake: FakeGhost;
  run: (opts?: RunOptions) => ReturnType<typeof scanSite>;
};
type RunOptions = {
  items?: SelectionItem[];
  limits?: Partial<ScanLimits>;
  now?: () => number;
};

function harness(
  state: ReturnType<typeof sampleState> = sampleState(),
  clientLimits: Partial<ClientLimits> = {},
): Harness {
  const fake = createFakeGhost({ siteBase: SITE, key: DEFAULT_KEY, ...state });
  const client = createGhostClient({
    fetch: fake.fetch,
    siteBase: SITE,
    key: DEFAULT_KEY,
    sleep: async () => undefined,
    limits: { minRequestGapMs: 0, ...clientLimits },
  });
  return {
    fake,
    run: (opts = {}) =>
      scanSite({
        client,
        items: opts.items ?? [],
        siteHost: HOST,
        ...(opts.limits ? { limits: opts.limits } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      }),
  };
}

async function codeOf(promise: Promise<unknown>): Promise<GhostErrorCode> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GhostError, String(error));
    return error.code;
  }
  assert.fail("expected a GhostError");
}

function manyPosts(count: number, from = 1): FakeItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: hexId(from + i),
    type: "post" as const,
    title: `Post ${from + i}`,
  }));
}

const ids = (page: { items: { externalId: string }[] }): string[] =>
  page.items.map((i) => i.externalId);

test("an empty selection lists posts and pages and skips members-only items", async () => {
  const { fake, run } = harness();
  const page = await run();
  assert.equal(page.complete, true);
  assert.equal(page.reconcileMissing, true);
  assert.equal(page.checkpoint, null);
  assert.deepEqual(ids(page), [
    `ghost:page:${hexId(3)}`,
    `ghost:post:${hexId(1)}`,
    `ghost:post:${hexId(2)}`,
  ]);
  assert.deepEqual([...new Set(fake.requests.map((r) => r.path))].sort(), [
    "/ghost/api/content/pages/",
    "/ghost/api/content/posts/",
  ]);
  assert.equal(page.warnings.length, 1);
  assert.match(page.warnings[0] as string, /\b1\b/);
});

test("type:page lists only pages", async () => {
  const { fake, run } = harness();
  const page = await run({ items: [{ id: "type:page", kind: "type" }] });
  assert.deepEqual(ids(page), [`ghost:page:${hexId(3)}`]);
  assert.ok(fake.requests.every((r) => r.path.endsWith("/pages/")));
  assert.deepEqual(page.warnings, []);
});

test("a tag selection lists its posts and pages and nothing else", async () => {
  const state = sampleState();
  state.items.push({
    id: hexId(5),
    type: "page",
    title: "Tagged page",
    tags: [hexId(0x101)],
  });
  const { fake, run } = harness(state);
  const page = await run({
    items: [{ id: `tag:${hexId(0x101)}`, kind: "tag" }],
  });
  assert.deepEqual(ids(page), [
    `ghost:page:${hexId(5)}`,
    `ghost:post:${hexId(1)}`,
    `ghost:post:${hexId(2)}`,
  ]);
  assert.equal(page.reconcileMissing, true);
  for (const request of fake.requests) {
    assert.equal(request.query.filter, `tags.id:[${hexId(0x101)}]`);
  }
  assert.equal(fake.requests.length, 2);
});

test("an item reached through two lists is emitted once", async () => {
  const { fake, run } = harness();
  const page = await run({
    items: [
      { id: `tag:${hexId(0x101)}`, kind: "tag" },
      { id: `post:${hexId(1)}`, kind: "post" },
      { id: `post:${hexId(2)}`, kind: "post" },
    ],
  });
  assert.deepEqual(ids(page), [
    `ghost:post:${hexId(1)}`,
    `ghost:post:${hexId(2)}`,
  ]);
  const postLists = fake.requests.filter((r) => r.path.endsWith("/posts/"));
  assert.equal(postLists.length, 2);
});

test("250 selected ids go out as three lists of at most 100", async () => {
  const { fake, run } = harness();
  const selected = Array.from({ length: 250 }, (_, i) => ({
    id: `post:${hexId(1000 + i)}`,
    kind: "post",
  }));
  const page = await run({ items: selected });
  assert.deepEqual(page.items, []);
  assert.equal(page.reconcileMissing, true);
  assert.equal(fake.requests.length, 3);
  const sizes = fake.requests.map(
    (r) => (r.query.filter as string).split(",").length,
  );
  assert.deepEqual(sizes, [ID_BATCH, ID_BATCH, 50]);
  for (const request of fake.requests) {
    assert.match(request.query.filter as string, /^id:\[/);
  }
});

test("250 tag ids are batched on both routes", async () => {
  const { fake, run } = harness();
  const selected = Array.from({ length: 250 }, (_, i) => ({
    id: `tag:${hexId(2000 + i)}`,
    kind: "tag",
  }));
  await run({ items: selected });
  const posts = fake.requests.filter((r) => r.path.endsWith("/posts/"));
  const pages = fake.requests.filter((r) => r.path.endsWith("/pages/"));
  assert.equal(posts.length, 3);
  assert.equal(pages.length, 3);
});

test("a total that changes mid-list restarts the list and then succeeds", async () => {
  const { fake, run } = harness({
    items: manyPosts(150),
    tags: [],
    authors: [],
  });
  let grown = false;
  fake.onBeforeRequest((request, f) => {
    if (!grown && request.query.page === "2") {
      grown = true;
      f.state.items.push(...manyPosts(1, 900));
    }
  });
  const page = await run({ items: [{ id: "type:post", kind: "type" }] });
  assert.equal(page.reconcileMissing, true);
  assert.equal(page.items.length, 151);
  assert.deepEqual(page.warnings, []);
});

test("a total that always changes ends incomplete and never reconciles", async () => {
  const { fake, run } = harness({
    items: manyPosts(150),
    tags: [],
    authors: [],
  });
  let next = 900;
  fake.onBeforeRequest((request, f) => {
    if (request.query.page === "2") f.state.items.push(...manyPosts(1, next++));
  });
  const page = await run({ items: [{ id: "type:post", kind: "type" }] });
  assert.deepEqual(page.items, []);
  assert.equal(page.reconcileMissing, false);
  assert.equal(page.checkpoint, null);
  assert.deepEqual(page.warnings, [SCAN_UNSTABLE_WARNING]);
  const firstPages = fake.requests.filter((r) => r.query.page === "1");
  assert.equal(firstPages.length, MAX_SCAN_RESTARTS + 1);
});

test("members-only items are absent, counted, and a complete scan still reconciles", async () => {
  const { run } = harness({
    items: [
      { id: hexId(1), visibility: "members", title: "A" },
      { id: hexId(2), visibility: "paid", title: "B" },
    ],
    tags: [],
    authors: [],
  });
  const page = await run();
  assert.deepEqual(page.items, []);
  assert.equal(page.complete, true);
  assert.equal(page.reconcileMissing, true);
  assert.equal(page.warnings.length, 1);
  assert.match(page.warnings[0] as string, /\b2\b/);
});

function assertIncomplete(page: Awaited<ReturnType<typeof scanSite>>): void {
  assert.deepEqual(page.items, []);
  assert.equal(page.complete, true);
  assert.equal(page.reconcileMissing, false);
  assert.equal(page.checkpoint, null);
  assert.deepEqual(page.warnings, [SCAN_NARROW_WARNING]);
}

test("the item cap ends the scan incomplete (a list larger than the cap)", async () => {
  const { run } = harness();
  assertIncomplete(await run({ limits: { MAX_ITEMS: 2 } }));
});

test("the item cap counts distinct items across lists", async () => {
  const { run } = harness();
  // posts: 3 listed (incl. members-only), pages: 1 => 4 distinct > 3.
  assertIncomplete(await run({ limits: { MAX_ITEMS: 3 } }));
});

test("the request cap ends the scan incomplete before the next request", async () => {
  const { fake, run } = harness();
  // One call may need its request plus two retries: 3 + 1 > 3 stops the scan
  // before the second list.
  assertIncomplete(await run({ limits: { MAX_REQUESTS: 3 } }));
  assert.equal(fake.requests.length, 1);
});

test("a retry sequence near the end of the budget ends gracefully, never TOO_LARGE", async () => {
  const { fake, run } = harness(
    { items: manyPosts(400), tags: [], authors: [] },
    { maxRequests: 5 },
  );
  // Page 3 is rate limited once (a retry), page 4 would be rate limited again.
  fake.failNext(
    { status: 429, headers: { "retry-after": "0" }, body: "" },
    1,
    (r) => r.query.page === "3",
  );
  fake.failNext(
    { status: 429, headers: { "retry-after": "0" }, body: "" },
    5,
    (r) => r.query.page === "4",
  );
  const page = await run({
    items: [{ id: "type:post", kind: "type" }],
    limits: { MAX_REQUESTS: 5 },
  });
  assertIncomplete(page);
  // Pages 1, 2, 3 and the retry of 3: the fourth page was never started.
  assert.equal(fake.requests.length, 4);
  assert.ok(fake.requests.every((r) => r.query.page !== "4"));
});

test("the client's own request ceiling is an incomplete scan, not TOO_LARGE", async () => {
  const { fake, run } = harness(sampleState(), { maxRequests: 2 });
  const selected = Array.from({ length: 250 }, (_, i) => ({
    id: `post:${hexId(1000 + i)}`,
    kind: "post",
  }));
  assertIncomplete(await run({ items: selected }));
  assert.equal(fake.requests.length, 2);
});

test("the deadline ends the scan incomplete (injected clock)", async () => {
  const { fake, run } = harness();
  let t = 0;
  fake.onBeforeRequest(() => {
    t += 1_000;
  });
  const page = await run({ now: () => t, limits: { SCAN_TIMEOUT_MS: 500 } });
  assertIncomplete(page);
  assert.equal(fake.requests.length, 1);
});

test("a 500 in the middle of a list is BAD_RESPONSE", async () => {
  const { fake, run } = harness({
    items: manyPosts(150),
    tags: [],
    authors: [],
  });
  fake.failNext({ status: 500 }, 5, (r) => r.query.page === "2");
  assert.equal(
    await codeOf(run({ items: [{ id: "type:post", kind: "type" }] })),
    "BAD_RESPONSE",
  );
});

test("a 404 in the middle of a list is BAD_RESPONSE", async () => {
  const { fake, run } = harness({
    items: manyPosts(150),
    tags: [],
    authors: [],
  });
  fake.failNext({ status: 404 }, 1, (r) => r.query.page === "2");
  assert.equal(
    await codeOf(run({ items: [{ id: "type:post", kind: "type" }] })),
    "BAD_RESPONSE",
  );
});

test("a malformed list item is BAD_RESPONSE", async () => {
  const { fake, run } = harness();
  fake.state.items.push({ id: "not-an-id" });
  assert.equal(await codeOf(run()), "BAD_RESPONSE");
});

test("a deleted selected single is skipped and the scan reconciles", async () => {
  const { run } = harness();
  const page = await run({
    items: [
      { id: `post:${hexId(0xdead)}`, kind: "post" },
      { id: `post:${hexId(1)}`, kind: "post" },
    ],
  });
  assert.deepEqual(ids(page), [`ghost:post:${hexId(1)}`]);
  assert.equal(page.reconcileMissing, true);
});

test("a hostile url fails the scan with LINK_INVALID", async () => {
  const state = sampleState();
  state.items[0] = { ...state.items[0]!, url: "http://evil.example/x/" };
  const { run } = harness(state);
  assert.equal(await codeOf(run()), "LINK_INVALID");
});

test("a malformed selection is CONFIG_INVALID before any request", async () => {
  const { fake, run } = harness();
  assert.equal(
    await codeOf(run({ items: [{ id: "post:1", kind: "post" }] })),
    "CONFIG_INVALID",
  );
  assert.equal(fake.requests.length, 0);
});

test("two scans of an unchanged site give identical items and hashes", async () => {
  const { run } = harness();
  const first = await run();
  const second = await run();
  assert.deepEqual(second, first);
  assert.ok(
    first.items.every((i) => /^[0-9a-f]{64}$/.test(i.contentHash ?? "")),
  );
});

test("renaming a tag changes only the hashes of the items that carry it", async () => {
  const { fake, run } = harness();
  const before = await run();
  const tag = fake.state.tags.find((t) => t.id === hexId(0x102))!;
  tag.name = "Guides, renamed";
  const after = await run();
  const hashes = (p: typeof before) =>
    new Map(p.items.map((i) => [i.externalId, i.contentHash]));
  const a = hashes(before);
  const b = hashes(after);
  const changed = [...a.keys()].filter((k) => a.get(k) !== b.get(k));
  // Only post 2 carries the Guides tag.
  assert.deepEqual(changed, [`ghost:post:${hexId(2)}`]);
});

test("the key appears in no result", async () => {
  const { run } = harness();
  const complete = await run();
  const incomplete = await run({ limits: { MAX_ITEMS: 1 } });
  for (const page of [complete, incomplete]) {
    assert.ok(!JSON.stringify(page).includes(DEFAULT_KEY));
  }
});

test("a members-only single is skipped, counted, and the scan still reconciles", async () => {
  const { run } = harness();
  const page = await run({
    items: [{ id: `post:${hexId(4)}`, kind: "post" }],
  });
  assert.deepEqual(page.items, []);
  assert.equal(page.complete, true);
  assert.equal(page.reconcileMissing, true);
  assert.equal(page.warnings.length, 1);
  assert.match(page.warnings[0] as string, /\b1\b/);
});

test("restarts are counted per list", async () => {
  const items: FakeItem[] = [
    ...manyPosts(150),
    ...manyPosts(150, 5_000).map((i) => ({ ...i, type: "page" as const })),
  ];
  const { fake, run } = harness({ items, tags: [], authors: [] });
  const grown = new Set<string>();
  let next = 9_000;
  fake.onBeforeRequest((request, f) => {
    if (request.query.page !== "2" || grown.has(request.path)) return;
    grown.add(request.path);
    const type = request.path.endsWith("/pages/") ? "page" : "post";
    f.state.items.push({ id: hexId(next++), type });
  });
  const page = await run({ limits: { MAX_SCAN_RESTARTS: 1 } });
  assert.equal(page.reconcileMissing, true);
  assert.equal(page.items.length, 302);
  assert.equal(grown.size, 2);
});

test("a whole type with a tag reads that type unfiltered and the other by tag", async () => {
  const state = sampleState();
  state.items.push(
    { id: hexId(5), type: "page", title: "Tagged", tags: [hexId(0x101)] },
    { id: hexId(6), type: "page", title: "Untagged" },
  );
  const { fake, run } = harness(state);
  const page = await run({
    items: [
      { id: "type:post", kind: "type" },
      { id: `tag:${hexId(0x101)}`, kind: "tag" },
    ],
  });
  assert.deepEqual(ids(page), [
    `ghost:page:${hexId(5)}`,
    `ghost:post:${hexId(1)}`,
    `ghost:post:${hexId(2)}`,
  ]);
  const posts = fake.requests.filter((r) => r.path.endsWith("/posts/"));
  const pages = fake.requests.filter((r) => r.path.endsWith("/pages/"));
  assert.ok(posts.every((r) => r.query.filter === undefined));
  assert.ok(pages.every((r) => r.query.filter === `tags.id:[${hexId(0x101)}]`));
});

test("an item that turns members-only between two lists is read from the accessible copy", async () => {
  const { fake, run } = harness();
  fake.onBeforeRequest((request, f) => {
    if ((request.query.filter ?? "").startsWith("id:[")) {
      f.state.items[0]!.visibility = "members";
    }
  });
  const page = await run({
    items: [
      { id: `tag:${hexId(0x101)}`, kind: "tag" },
      { id: `post:${hexId(1)}`, kind: "post" },
    ],
  });
  assert.ok(ids(page).includes(`ghost:post:${hexId(1)}`));
  assert.deepEqual(page.warnings, []);
});

test("an item that turns public between two lists is emitted", async () => {
  const state = sampleState();
  state.items[0]!.visibility = "members";
  const { fake, run } = harness(state);
  fake.onBeforeRequest((request, f) => {
    if ((request.query.filter ?? "").startsWith("id:[")) {
      f.state.items[0]!.visibility = "public";
    }
  });
  const page = await run({
    items: [
      { id: `tag:${hexId(0x101)}`, kind: "tag" },
      { id: `post:${hexId(1)}`, kind: "post" },
    ],
  });
  assert.ok(ids(page).includes(`ghost:post:${hexId(1)}`));
  assert.deepEqual(page.warnings, []);
});
