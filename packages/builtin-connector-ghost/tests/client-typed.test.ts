import assert from "node:assert/strict";
import test from "node:test";
import { createGhostClient, type GhostClient } from "../src/client";
import { GhostError, type GhostErrorCode } from "../src/errors";
import { ID_BATCH } from "../src/limits";
import {
  createFakeGhost,
  DEFAULT_KEY,
  hexId,
  sampleState,
  type FakeFault,
  type FakeGhost,
  type FakeItem,
} from "./helpers/fake-ghost";

const SITE = "https://site.example";

function harness(items?: FakeItem[]): { fake: FakeGhost; client: GhostClient } {
  const state = sampleState();
  const fake = createFakeGhost({
    siteBase: SITE,
    key: DEFAULT_KEY,
    ...state,
    ...(items ? { items } : {}),
  });
  const client = createGhostClient({
    fetch: fake.fetch,
    siteBase: SITE,
    key: DEFAULT_KEY,
    sleep: async () => undefined,
    limits: { minRequestGapMs: 0 },
  });
  return { fake, client };
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

test("listItems sends the fixed fields, include, order and limit", async () => {
  const { fake, client } = harness();
  const out = await client.listItems("posts", { page: 1 });
  const request = fake.requests[0]!;
  assert.equal(request.path, "/ghost/api/content/posts/");
  assert.equal(
    request.query.fields,
    "id,slug,url,title,updated_at,published_at,visibility,access,canonical_url",
  );
  assert.equal(request.query.include, "tags");
  assert.equal(request.query.order, "id asc");
  assert.equal(request.query.limit, "100");
  assert.equal(request.query.page, "1");
  assert.equal(request.query.filter, undefined);
  // Three posts, one of them members-only; the page is on its own route.
  assert.equal(out.total, 3);
  assert.equal(out.pages, 1);
  assert.deepEqual(
    out.items.map((i) => [i.id, i.type, i.access]),
    [
      [hexId(1), "post", true],
      [hexId(2), "post", true],
      [hexId(4), "post", false],
    ],
  );
  assert.deepEqual(
    out.items[1]!.tags.map((t) => t.slug),
    ["news", "guides"],
  );
  const pages = await client.listItems("pages", { page: 1 });
  assert.deepEqual(
    pages.items.map((i) => [i.id, i.type]),
    [[hexId(3), "page"]],
  );
});

test("listItems filters by tag ids and by ids", async () => {
  const { fake, client } = harness();
  const byTag = await client.listItems("posts", {
    page: 1,
    tagIds: [hexId(0x102)],
  });
  assert.equal(fake.requests.at(-1)!.query.filter, `tags.id:[${hexId(0x102)}]`);
  assert.deepEqual(
    byTag.items.map((i) => i.id),
    [hexId(2)],
  );
  const byId = await client.listItems("posts", {
    page: 1,
    ids: [hexId(1), hexId(2)],
  });
  assert.equal(
    fake.requests.at(-1)!.query.filter,
    `id:[${hexId(1)},${hexId(2)}]`,
  );
  assert.equal(byId.items.length, 2);
});

test("listItems pages through a long list", async () => {
  const items: FakeItem[] = Array.from({ length: 230 }, (_, i) => ({
    id: hexId(i + 1),
  }));
  const { client } = harness(items);
  const first = await client.listItems("posts", { page: 1 });
  assert.equal(first.items.length, 100);
  assert.equal(first.total, 230);
  assert.equal(first.pages, 3);
  const last = await client.listItems("posts", { page: 3 });
  assert.equal(last.items.length, 30);
});

test("listItems refuses a bad call before any request", async () => {
  const { fake, client } = harness();
  const tooMany = Array.from({ length: ID_BATCH + 1 }, (_, i) => hexId(i + 1));
  await assert.rejects(
    client.listItems("posts", { page: 1, ids: tooMany }),
    RangeError,
  );
  await assert.rejects(
    client.listItems("posts", { page: 1, tagIds: tooMany }),
    RangeError,
  );
  await assert.rejects(
    client.listItems("posts", { page: 1, ids: [] }),
    RangeError,
  );
  await assert.rejects(
    client.listItems("posts", { page: 1, ids: [hexId(1)], tagIds: [hexId(2)] }),
    RangeError,
  );
  await assert.rejects(client.listItems("posts", { page: 0 }), RangeError);
  assert.equal(
    await codeOf(client.listItems("posts", { page: 1, ids: ["1' or '1"] })),
    "CONFIG_INVALID",
  );
  assert.equal(
    await codeOf(client.listItems("posts", { page: 1, tagIds: ["x"] })),
    "CONFIG_INVALID",
  );
  assert.equal(fake.requests.length, 0);
  // A full batch is fine.
  const full = Array.from({ length: ID_BATCH }, (_, i) => hexId(i + 1));
  await client.listItems("posts", { page: 1, ids: full });
  assert.equal(fake.requests.length, 1);
});

test("a 404 on a list route is BAD_RESPONSE, not a missing item", async () => {
  const { fake, client } = harness();
  fake.failNext({ status: 404, body: "{}" });
  assert.equal(
    await codeOf(client.listItems("posts", { page: 1 })),
    "BAD_RESPONSE",
  );
  fake.failNext({ status: 404, body: "{}" });
  assert.equal(await codeOf(client.listTags(1)), "BAD_RESPONSE");
  fake.failNext({ status: 404, body: "{}" });
  assert.equal(
    await codeOf(client.searchContent("x", "posts", 1)),
    "BAD_RESPONSE",
  );
});

test("a malformed list body is BAD_RESPONSE", async () => {
  const bodies: FakeFault[] = [
    { status: 200, body: JSON.stringify({ meta: {} }) },
    { status: 200, body: JSON.stringify({ posts: "x", meta: {} }) },
    {
      status: 200,
      body: JSON.stringify({ posts: [], meta: { pagination: {} } }),
    },
    {
      status: 200,
      body: JSON.stringify({
        posts: [{ id: "nope" }],
        meta: { pagination: { page: 1, pages: 1, total: 1 } },
      }),
    },
    { status: 200, body: JSON.stringify([]) },
  ];
  for (const fault of bodies) {
    const { fake, client } = harness();
    fake.failNext(fault);
    assert.equal(
      await codeOf(client.listItems("posts", { page: 1 })),
      "BAD_RESPONSE",
      JSON.stringify(fault),
    );
  }
});

test("getItem reads one item with html, tags and authors and no fields parameter", async () => {
  const { fake, client } = harness();
  const found = await client.getItem("posts", hexId(2));
  assert.ok(found);
  const request = fake.requests[0]!;
  assert.equal(request.path, `/ghost/api/content/posts/${hexId(2)}/`);
  assert.equal(request.query.formats, "html");
  assert.equal(request.query.include, "tags,authors");
  assert.equal(request.query.fields, undefined);
  assert.equal(found.id, hexId(2));
  assert.equal(found.type, "post");
  assert.equal(found.html, `<p>Body ${hexId(2)}</p>`);
  assert.deepEqual(found.authors, ["Ada"]);
  assert.deepEqual(
    found.tags.map((t) => t.name),
    ["News", "Guides"],
  );
  const page = await client.getItem("pages", hexId(3));
  assert.equal(page?.type, "page");
});

test("getItem returns null for a missing item and an item that is not what was asked", async () => {
  const { fake, client } = harness();
  assert.equal(await client.getItem("posts", hexId(0x999)), null);
  // The id of a page asked through the posts route is a 404 too.
  assert.equal(await client.getItem("posts", hexId(3)), null);
  assert.equal(
    await codeOf(client.getItem("posts", "not-an-id")),
    "CONFIG_INVALID",
  );
  // A site answering another item's body is not trusted.
  const other = harness();
  other.fake.failNext({
    status: 200,
    body: JSON.stringify({
      posts: [
        {
          id: hexId(1),
          slug: "s",
          url: "https://site.example/s/",
          title: "T",
          updated_at: "2026-01-01T00:00:00.000Z",
          published_at: null,
          visibility: "public",
          access: true,
          canonical_url: null,
          html: "",
          tags: [],
          authors: [],
        },
      ],
    }),
  });
  assert.equal(
    await codeOf(other.client.getItem("posts", hexId(2))),
    "BAD_RESPONSE",
  );
  void fake;
});

test("getItem on other failures throws, it does not return null", async () => {
  const { fake, client } = harness();
  fake.failNext({ status: 500 }, 3);
  assert.equal(await codeOf(client.getItem("posts", hexId(1))), "BAD_RESPONSE");
});

test("listTags reads tags page by page", async () => {
  const { fake, client } = harness();
  const out = await client.listTags(1);
  const request = fake.requests[0]!;
  assert.equal(request.path, "/ghost/api/content/tags/");
  assert.equal(request.query.limit, "100");
  assert.equal(request.query.page, "1");
  assert.deepEqual(
    out.tags.map((t) => [t.id, t.slug, t.name]),
    [
      [hexId(0x101), "news", "News"],
      [hexId(0x102), "guides", "Guides"],
    ],
  );
  assert.equal(out.pages, 1);
});

test("getSettings accepts a settings object and nothing else", async () => {
  const { fake, client } = harness();
  const out = await client.getSettings();
  assert.equal(out.title, "Example");
  assert.equal(fake.requests[0]!.path, "/ghost/api/content/settings/");
  for (const body of [{}, { settings: "x" }, []]) {
    const h = harness();
    h.fake.failNext({ status: 200, body: JSON.stringify(body) });
    assert.equal(await codeOf(h.client.getSettings()), "NOT_A_GHOST_SITE");
  }
  const h = harness();
  h.fake.failNext({ status: 404 });
  assert.equal(await codeOf(h.client.getSettings()), "NOT_A_GHOST_SITE");
});

test("searchContent filters by title with quotes escaped", async () => {
  const { fake, client } = harness([
    { id: hexId(1), title: "It's a trap" },
    { id: hexId(2), title: "Other" },
  ]);
  const out = await client.searchContent("It's", "posts", 1);
  const request = fake.requests[0]!;
  assert.equal(request.query.filter, "title:~'It\\'s'");
  assert.deepEqual(
    out.items.map((i) => i.id),
    [hexId(1)],
  );
  assert.equal(out.total, 1);
  // A backslash cannot undo the escape of the quote after it.
  await client.searchContent("a\\' or id:~'", "pages", 1);
  assert.equal(
    fake.requests.at(-1)!.query.filter,
    "title:~'a\\\\\\' or id:~\\''",
  );
  assert.equal(
    await codeOf(client.searchContent("   ", "posts", 1)),
    "CONFIG_INVALID",
  );
  assert.equal(
    await codeOf(client.searchContent("x".repeat(201), "posts", 1)),
    "CONFIG_INVALID",
  );
});
