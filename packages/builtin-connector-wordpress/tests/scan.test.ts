import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorDiscoveryPage } from "@sourceweft/contracts";
import { createWordPressClient, type WordPressClient } from "../src/client";
import { WordPressError } from "../src/errors";
import {
  NARROW_SELECTION_WARNING,
  scanSite,
  SITE_CHANGED_WARNING,
  type ScanLimits,
} from "../src/scan";
import type { SelectionItem } from "../src/selection-scope";
import {
  createFakeWordPress,
  type FakeCategory,
  type FakePost,
  type FakeWordPress,
  type FakeWordPressOptions,
} from "./helpers/fake-wordpress";

const SITE = "https://site.example";
const HOST = "site.example";
const CREDENTIAL = { username: "wpuser", secret: "app-pass-abcdef" };
const AUTH = `Basic ${Buffer.from(`${CREDENTIAL.username}:${CREDENTIAL.secret}`, "utf8").toString("base64")}`;

type Harness = { fake: FakeWordPress; client: WordPressClient };

function harness(
  options: { fake?: Partial<FakeWordPressOptions>; login?: boolean } = {},
): Harness {
  const fake = createFakeWordPress({
    siteBase: SITE,
    root: "pretty",
    credential: CREDENTIAL,
    ...options.fake,
  });
  const client = createWordPressClient({
    fetch: fake.fetch,
    siteBase: SITE,
    allowWpcom: false,
    authorization: options.login ? AUTH : undefined,
    now: () => 0,
    sleep: async () => {},
  });
  return { fake, client };
}

type ScanOptions = {
  items?: SelectionItem[];
  includeUnpublished?: boolean;
  now?: () => number;
  limits?: Partial<ScanLimits>;
  signal?: AbortSignal;
};

function scan(
  client: WordPressClient,
  options: ScanOptions = {},
): Promise<ConnectorDiscoveryPage> {
  return scanSite({
    client,
    items: options.items ?? [],
    includeUnpublished: options.includeUnpublished ?? false,
    siteHost: HOST,
    now: options.now,
    limits: options.limits,
    signal: options.signal,
  });
}

const item = (id: string): SelectionItem => ({
  id,
  kind: id.split(":")[0] ?? "",
});

async function failure(promise: Promise<unknown>): Promise<WordPressError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof WordPressError, String(error));
    return error;
  }
  assert.fail("expected a WordPressError");
}

function postsRequests(fake: FakeWordPress) {
  return fake.requests.filter((r) => r.path.endsWith("/wp/v2/posts"));
}

function ids(page: ConnectorDiscoveryPage): string[] {
  return page.items.map((i) => i.externalId).sort();
}

/** A shape-valid list row the fake can serve verbatim through a fault. */
function listRow(id: number): Record<string, unknown> {
  return {
    id,
    type: "post",
    status: "publish",
    link: `${SITE}/?p=${id}`,
    modified_gmt: "2026-01-01T00:00:00",
    title: { rendered: `Item ${id}` },
    categories: [],
    tags: [],
    author: 1,
  };
}

function manyPosts(count: number): FakePost[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    title: `Post ${i + 1}`,
  }));
}

// --------------------------------------------------------------- selection

test("an empty selection lists every post and page once, and reconciles", async () => {
  const { fake, client } = harness({
    fake: {
      posts: [
        { id: 1, type: "post", title: "First" },
        { id: 2, type: "post", title: "Second" },
        { id: 3, type: "page", title: "About" },
      ],
    },
  });
  const page = await scan(client);
  assert.deepEqual(ids(page), [
    "wordpress:page:3",
    "wordpress:post:1",
    "wordpress:post:2",
  ]);
  assert.equal(page.complete, true);
  assert.equal(page.reconcileMissing, true);
  assert.equal(page.checkpoint, null);
  assert.equal(
    fake.requests.some((r) => r.path.endsWith("/wp/v2/posts")),
    true,
  );
  assert.equal(
    fake.requests.some((r) => r.path.endsWith("/wp/v2/pages")),
    true,
  );
});

test("type:page lists only pages and never touches the posts route", async () => {
  const { fake, client } = harness({
    fake: {
      posts: [
        { id: 1, type: "post" },
        { id: 3, type: "page", title: "About" },
      ],
    },
  });
  const page = await scan(client, { items: [item("type:page")] });
  assert.deepEqual(ids(page), ["wordpress:page:3"]);
  assert.equal(postsRequests(fake).length, 0);
});

test("a category expands to its subtree: a grandchild is in, a sibling is out", async () => {
  const categories: FakeCategory[] = [
    { id: 10, name: "Tech", parent: 0 },
    { id: 11, name: "Web", parent: 10 },
    { id: 12, name: "CSS", parent: 11 },
    { id: 13, name: "Life", parent: 0 },
  ];
  const { client } = harness({
    fake: {
      categories,
      posts: [
        { id: 1, categories: [12], title: "Grandchild" },
        { id: 2, categories: [13], title: "Sibling" },
      ],
    },
  });
  const page = await scan(client, { items: [item("category:10")] });
  assert.deepEqual(ids(page), ["wordpress:post:1"]);
});

test("a post reached through a category and as a single appears once", async () => {
  const { client } = harness({
    fake: {
      categories: [{ id: 10, name: "Tech", parent: 0 }],
      posts: [{ id: 1, categories: [10], title: "Only" }],
    },
  });
  const page = await scan(client, {
    items: [item("category:10"), item("post:1")],
  });
  assert.deepEqual(ids(page), ["wordpress:post:1"]);
  assert.equal(page.items.length, 1);
});

// ----------------------------------------------------- restart on instability

test("a total that moves mid-listing restarts the route, then succeeds", async () => {
  const { fake, client } = harness({ fake: { posts: manyPosts(101) } });
  // The first page-2 read reports a different X-WP-Total, forcing one restart.
  fake.failNext(
    {
      status: 200,
      headers: { "X-WP-Total": "999", "X-WP-TotalPages": "2" },
      body: JSON.stringify([listRow(101)]),
    },
    1,
    (r) => r.path.endsWith("/wp/v2/posts") && r.query.page === "2",
  );
  const page = await scan(client);
  assert.equal(page.complete, true);
  assert.equal(page.reconcileMissing, true);
  assert.equal(page.items.length, 101);
});

test("a total that keeps moving gives the incomplete, non-reconciling result", async () => {
  const { fake, client } = harness({ fake: { posts: manyPosts(101) } });
  // Every page-2 read reports a different X-WP-Total, so no restart stabilises.
  fake.failNext(
    {
      status: 200,
      headers: { "X-WP-Total": "999", "X-WP-TotalPages": "2" },
      body: JSON.stringify([listRow(101)]),
    },
    10,
    (r) => r.path.endsWith("/wp/v2/posts") && r.query.page === "2",
  );
  const page = await scan(client);
  assert.equal(page.complete, false);
  assert.equal(page.reconcileMissing, false);
  assert.deepEqual(page.items, []);
  assert.deepEqual(page.warnings, [SITE_CHANGED_WARNING]);
});

// ------------------------------------------------------- drafts and status

test("the public path never sends a status parameter", async () => {
  const { fake, client } = harness({ fake: { posts: manyPosts(2) } });
  await scan(client);
  assert.equal(
    fake.requests.every((r) => !("status" in r.query)),
    true,
  );
});

test("includeUnpublished sends the status list and carries status in metadata", async () => {
  const { fake, client } = harness({
    login: true,
    fake: {
      posts: [
        { id: 1, title: "Published" },
        { id: 2, status: "draft", title: "Draft" },
      ],
    },
  });
  const page = await scan(client, { includeUnpublished: true });
  assert.equal(
    postsRequests(fake)[0]?.query.status,
    "publish,private,draft,pending,future",
  );
  const draft = page.items.find((i) => i.externalId === "wordpress:post:2");
  assert.equal(draft?.metadata.status, "draft");
});

// --------------------------------------------------------------- link guard

test("a link under another host aborts the scan with LINK_HOST_MISMATCH", async () => {
  const { client } = harness({
    fake: { posts: [{ id: 1, link: "https://evil.example/x" }] },
  });
  assert.equal((await failure(scan(client))).code, "LINK_HOST_MISMATCH");
});

// ----------------------------------------------------------------- caps

test("the item cap ends the scan incomplete and archives nothing", async () => {
  const { client } = harness({ fake: { posts: manyPosts(3) } });
  const page = await scan(client, { limits: { MAX_ITEMS: 1 } });
  assert.equal(page.complete, false);
  assert.equal(page.reconcileMissing, false);
  assert.deepEqual(page.items, []);
  assert.deepEqual(page.warnings, [NARROW_SELECTION_WARNING]);
});

test("the request cap ends the scan incomplete and archives nothing", async () => {
  const { client } = harness({ fake: { posts: manyPosts(3) } });
  const page = await scan(client, { limits: { MAX_REQUESTS: 2 } });
  assert.equal(page.complete, false);
  assert.equal(page.reconcileMissing, false);
  assert.deepEqual(page.warnings, [NARROW_SELECTION_WARNING]);
});

test("the wall-clock deadline ends the scan incomplete and archives nothing", async () => {
  const { client } = harness({ fake: { posts: manyPosts(3) } });
  let calls = 0;
  const now = () => (calls++ === 0 ? 0 : 1_000_000);
  const page = await scan(client, {
    now,
    limits: { SCAN_TIMEOUT_MS: 1_000 },
  });
  assert.equal(page.complete, false);
  assert.equal(page.reconcileMissing, false);
  assert.deepEqual(page.warnings, [NARROW_SELECTION_WARNING]);
});

// ----------------------------------------------------- half-read listing

test("a 500 mid-listing aborts with BAD_RESPONSE and never reconciles", async () => {
  const { fake, client } = harness({ fake: { posts: manyPosts(101) } });
  // The 500 persists through the transport's retries (attempts = MAX_RETRIES + 1).
  fake.failNext({ status: 500 }, 3, (r) => r.query.page === "2");
  assert.equal((await failure(scan(client))).code, "BAD_RESPONSE");
});

// --------------------------------------------------- gone selections

test("a deleted selected category yields no items but still reconciles", async () => {
  const { client } = harness({
    fake: {
      categories: [{ id: 10, name: "Tech", parent: 0 }],
      posts: [{ id: 1, categories: [10] }],
    },
  });
  const page = await scan(client, { items: [item("category:99")] });
  assert.deepEqual(page.items, []);
  assert.equal(page.complete, true);
  assert.equal(page.reconcileMissing, true);
});

test("a deleted selected single post is skipped on a complete scan", async () => {
  const { client } = harness({ fake: { posts: [{ id: 1 }] } });
  const page = await scan(client, { items: [item("post:99")] });
  assert.deepEqual(page.items, []);
  assert.equal(page.complete, true);
  assert.equal(page.reconcileMissing, true);
});

test("a selected single that became private is treated as gone, not an error", async () => {
  // The public connector asks for a draft single; the site answers 401
  // rest_forbidden, which R8b maps to 'gone' (skipped), not a login wall.
  const { client } = harness({
    fake: { posts: [{ id: 1, status: "draft" }] },
  });
  const page = await scan(client, { items: [item("post:1")] });
  assert.deepEqual(page.items, []);
  assert.equal(page.complete, true);
});

// ------------------------------------------------------ determinism

test("two scans of an unchanged site produce identical items and hashes", async () => {
  const build = () =>
    harness({
      fake: {
        categories: [{ id: 10, name: "Tech", parent: 0 }],
        tags: [{ id: 20, name: "News" }],
        users: [{ id: 5, name: "Ann" }],
        posts: [
          { id: 1, categories: [10], tags: [20], author: 5 },
          { id: 2, categories: [10], tags: [20], author: 5 },
          { id: 3, type: "page", title: "About", author: 5 },
        ],
      },
    });
  const first = await scan(build().client);
  const second = await scan(build().client);
  const shape = (page: ConnectorDiscoveryPage) =>
    page.items.map((i) => [i.externalId, i.contentHash] as const);
  assert.deepEqual(shape(first), shape(second));
});

test("renaming a category changes only the hashes of its posts", async () => {
  const { fake, client } = harness({
    fake: {
      categories: [
        { id: 10, name: "Tech", parent: 0 },
        { id: 11, name: "Life", parent: 0 },
      ],
      tags: [{ id: 20, name: "News" }],
      posts: [
        { id: 1, categories: [10], tags: [20] },
        { id: 2, categories: [11], tags: [20] },
      ],
    },
  });
  const before = await scan(client);
  fake.setState({
    categories: [
      { id: 10, name: "Technology", parent: 0 },
      { id: 11, name: "Life", parent: 0 },
    ],
  });
  const after = await scan(client);
  const hashOf = (page: ConnectorDiscoveryPage, id: string) =>
    page.items.find((i) => i.externalId === id)?.contentHash;
  assert.notEqual(
    hashOf(before, "wordpress:post:1"),
    hashOf(after, "wordpress:post:1"),
  );
  assert.equal(
    hashOf(before, "wordpress:post:2"),
    hashOf(after, "wordpress:post:2"),
  );
});
