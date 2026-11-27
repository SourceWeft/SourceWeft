import assert from "node:assert/strict";
import test from "node:test";
import {
  createFakeGhost,
  DEFAULT_KEY,
  hexId,
  sampleState,
  type FakeGhost,
  type FakeItem,
} from "./helpers/fake-ghost";

const SITE = "https://site.example";
const BASE = `${SITE}/ghost/api/content`;

function make(extra: Partial<Parameters<typeof createFakeGhost>[0]> = {}) {
  return createFakeGhost({ siteBase: SITE, ...sampleState(), ...extra });
}

type ApiItem = {
  id: string;
  title: string;
  html: string;
  url: string;
  access: boolean;
  visibility: string;
  tags: [{ slug: string; name: string }, ...{ slug: string; name: string }[]];
  authors: [{ name: string }, ...{ name: string }[]];
};

type ApiBody = {
  errors: [{ code: string | null }];
  settings: { title: string };
  posts: [ApiItem, ...ApiItem[]];
  pages: [ApiItem, ...ApiItem[]];
  tags: [{ name: string }, ...{ name: string }[]];
  authors: [{ name: string }, ...{ name: string }[]];
  meta: {
    pagination: {
      page: number;
      limit: number;
      pages: number;
      total: number;
      next: number | null;
      prev: number | null;
    };
  };
};

async function get(fake: FakeGhost, path: string) {
  const response = await fake.fetch(`${BASE}/${path}`, { redirect: "manual" });
  const text = await response.text();
  let body = {} as ApiBody;
  try {
    body = JSON.parse(text) as ApiBody;
  } catch {
    // not JSON
  }
  return { status: response.status, body, text, headers: response.headers };
}

function manyItems(count: number): FakeItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: hexId(i + 1),
    type: "post" as const,
    title: `Post ${i + 1}`,
    published_at: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
  }));
}

test("the key is checked: none is 403, a wrong one is UNKNOWN_CONTENT_API_KEY, headers do not count", async () => {
  const fake = make();
  const none = await get(fake, "settings/");
  assert.equal(none.status, 403);
  assert.equal(none.body.errors[0].code, null);

  const wrong = await get(fake, "settings/?key=ffffffffffffffffffffffffff");
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.errors[0].code, "UNKNOWN_CONTENT_API_KEY");

  const headerForms: Record<string, string>[] = [
    { authorization: `Ghost ${DEFAULT_KEY}` },
    { authorization: `GhostContent ${DEFAULT_KEY}` },
    { "x-ghost-key": DEFAULT_KEY },
  ];
  for (const headers of headerForms) {
    const response = await fake.fetch(`${BASE}/settings/`, { headers });
    assert.equal(response.status, 403);
  }

  const ok = await get(fake, `settings/?key=${DEFAULT_KEY}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.settings.title, "Example");
});

test("the no-slash form answers 301 to the slash form with the query, in a subfolder too", async () => {
  const flat = make();
  const a = await get(flat, `posts?limit=1&key=${DEFAULT_KEY}`);
  assert.equal(a.status, 301);
  assert.equal(
    a.headers.get("location"),
    `${BASE}/posts/?limit=1&key=${DEFAULT_KEY}`,
  );

  const sub = createFakeGhost({ siteBase: `${SITE}/blog`, ...sampleState() });
  const response = await sub.fetch(
    `${SITE}/blog/ghost/api/content/posts?key=${DEFAULT_KEY}`,
    { redirect: "manual" },
  );
  assert.equal(response.status, 301);
  assert.equal(
    response.headers.get("location"),
    `${SITE}/blog/ghost/api/content/posts/?key=${DEFAULT_KEY}`,
  );
  const ok = await sub.fetch(
    `${SITE}/blog/ghost/api/content/posts/?key=${DEFAULT_KEY}`,
  );
  assert.equal(ok.status, 200);
  // The root-mounted API does not exist on a subfolder site.
  const wrongPlace = await sub.fetch(
    `${SITE}/ghost/api/content/posts/?key=${DEFAULT_KEY}`,
  );
  assert.equal(wrongPlace.status, 404);
});

test("lists carry meta.pagination and clamp limit to 100", async () => {
  const fake = make({ items: manyItems(250) });
  const first = await get(fake, `posts/?limit=500&key=${DEFAULT_KEY}`);
  assert.equal(first.body.posts.length, 100);
  assert.deepEqual(first.body.meta.pagination, {
    page: 1,
    limit: 100,
    pages: 3,
    total: 250,
    next: 2,
    prev: null,
  });
  const last = await get(fake, `posts/?limit=100&page=3&key=${DEFAULT_KEY}`);
  assert.equal(last.body.posts.length, 50);
  assert.equal(last.body.meta.pagination.next, null);
  assert.equal(last.body.meta.pagination.prev, 2);
  const dflt = await get(fake, `posts/?key=${DEFAULT_KEY}`);
  assert.equal(dflt.body.meta.pagination.limit, 15);
});

test("order id asc is stable across pages and covers every item once", async () => {
  const fake = make({ items: manyItems(130) });
  const ids: string[] = [];
  for (let page = 1; page <= 2; page += 1) {
    const res = await get(
      fake,
      `posts/?limit=100&page=${page}&order=${encodeURIComponent("id asc")}&key=${DEFAULT_KEY}`,
    );
    ids.push(...res.body.posts.map((p: { id: string }) => p.id));
  }
  assert.equal(new Set(ids).size, 130);
  assert.deepEqual(ids, [...ids].sort());
});

test("fields limits a list and include adds tags and authors", async () => {
  const fake = make();
  const res = await get(
    fake,
    `posts/?fields=${encodeURIComponent("id,title")}&include=tags,authors&filter=${encodeURIComponent(`id:[${hexId(2)}]`)}&key=${DEFAULT_KEY}`,
  );
  assert.equal(res.body.posts.length, 1);
  const post = res.body.posts[0];
  assert.deepEqual(Object.keys(post).sort(), [
    "authors",
    "id",
    "tags",
    "title",
  ]);
  assert.deepEqual(
    post.tags.map((t: { slug: string }) => t.slug),
    ["news", "guides"],
  );
  assert.equal(post.authors[0].name, "Ada");

  const plain = await get(
    fake,
    `posts/?filter=${encodeURIComponent(`id:[${hexId(2)}]`)}&key=${DEFAULT_KEY}`,
  );
  assert.equal(plain.body.posts[0].tags, undefined);
  assert.ok("html" in plain.body.posts[0]);
});

test("the filters tag:, tags.id:[…], id:[…] and title:~'…' select items", async () => {
  const fake = make();
  const run = async (filter: string, route: "posts" | "pages" = "posts") =>
    (
      await get(
        fake,
        `${route}/?filter=${encodeURIComponent(filter)}&order=${encodeURIComponent("id asc")}&key=${DEFAULT_KEY}`,
      )
    ).body[route].map((p: { id: string }) => p.id);

  assert.deepEqual(await run("tag:news"), [hexId(1), hexId(2)]);
  assert.deepEqual(await run("tag:guides"), [hexId(2)]);
  assert.deepEqual(await run(`tags.id:[${hexId(0x102)}]`), [hexId(2)]);
  assert.deepEqual(await run(`tags.id:[${hexId(0x101)},${hexId(0x102)}]`), [
    hexId(1),
    hexId(2),
  ]);
  assert.deepEqual(await run(`id:[${hexId(1)},${hexId(4)}]`), [
    hexId(1),
    hexId(4),
  ]);
  assert.deepEqual(await run("title:~'sec'"), [hexId(2)]);
  assert.deepEqual(await run("id:[]"), []);
  assert.deepEqual(await run(`id:[${hexId(3)}]`, "pages"), [hexId(3)]);
  assert.deepEqual(await run("title:~'abo'", "pages"), [hexId(3)]);
});

test("a single quote in a title filter is read as an escaped quote", async () => {
  const fake = make({
    items: [{ id: hexId(9), type: "post", title: "Ada's notes" }],
  });
  const res = await get(
    fake,
    `posts/?filter=${encodeURIComponent("title:~'Ada\\'s'")}&key=${DEFAULT_KEY}`,
  );
  assert.equal(res.body.posts.length, 1);
  // An unescaped quote is not a filter the fake understands.
  const broken = await get(
    fake,
    `posts/?filter=${encodeURIComponent("title:~'Ada's'")}&key=${DEFAULT_KEY}`,
  );
  assert.equal(broken.status, 400);
});

test("a members-only item has access false and a teaser instead of its body", async () => {
  const fake = make({
    items: [
      { id: hexId(1), html: "<p>Full body</p>" },
      {
        id: hexId(2),
        html: "<p>Secret body</p>",
        visibility: "paid",
        teaser: "<p>Just a teaser</p>",
      },
    ],
  });
  const res = await get(
    fake,
    `posts/?order=${encodeURIComponent("id asc")}&key=${DEFAULT_KEY}`,
  );
  const open = res.body.posts[0];
  const locked = res.body.posts[1]!;
  assert.equal(open.access, true);
  assert.equal(open.html, "<p>Full body</p>");
  assert.equal(locked.access, false);
  assert.equal(locked.visibility, "paid");
  assert.equal(locked.html, "<p>Just a teaser</p>");
  assert.ok(!res.text.includes("Secret body"));
});

test("a draft item is never served", async () => {
  const fake = make({
    items: [{ id: hexId(1), status: "draft" }, { id: hexId(2) }],
  });
  const list = await get(fake, `posts/?key=${DEFAULT_KEY}`);
  assert.equal(list.body.posts.length, 1);
  const single = await get(fake, `posts/${hexId(1)}/?key=${DEFAULT_KEY}`);
  assert.equal(single.status, 404);
});

test("the single-item route answers 404 for a missing id and rejects fields with tags", async () => {
  const fake = make();
  const found = await get(
    fake,
    `posts/${hexId(2)}/?formats=html&include=tags,authors&key=${DEFAULT_KEY}`,
  );
  assert.equal(found.status, 200);
  assert.equal(found.body.posts[0].id, hexId(2));
  assert.equal(found.body.posts[0].tags.length, 2);
  assert.equal(found.body.posts[0].authors.length, 1);

  const missing = await get(fake, `posts/${hexId(0xbeef)}/?key=${DEFAULT_KEY}`);
  assert.equal(missing.status, 404);

  const wrongType = await get(fake, `pages/${hexId(1)}/?key=${DEFAULT_KEY}`);
  assert.equal(wrongType.status, 404);

  const broken = await get(
    fake,
    `posts/${hexId(2)}/?fields=${encodeURIComponent("id,tags")}&key=${DEFAULT_KEY}`,
  );
  assert.equal(broken.status, 400);
});

test("tags and authors list with ids filter and pagination", async () => {
  const fake = make();
  const tags = await get(fake, `tags/?limit=1&key=${DEFAULT_KEY}`);
  assert.equal(tags.body.tags.length, 1);
  assert.equal(tags.body.meta.pagination.total, 2);
  assert.equal(tags.body.meta.pagination.pages, 2);
  const some = await get(
    fake,
    `tags/?filter=${encodeURIComponent(`id:[${hexId(0x102)}]`)}&key=${DEFAULT_KEY}`,
  );
  assert.deepEqual(
    some.body.tags.map((t: { name: string }) => t.name),
    ["Guides"],
  );
  const authors = await get(fake, `authors/?key=${DEFAULT_KEY}`);
  assert.equal(authors.body.authors[0].name, "Ada");
});

test("hostile url values are served verbatim", async () => {
  const hostile = [
    "javascript:alert(1)",
    "https://user:pw@example.com/p/",
    "https://example.com:8443/p/",
    "/relative/",
  ];
  const fake = make({
    items: hostile.map((url, i) => ({ id: hexId(i + 1), url })),
  });
  const res = await get(
    fake,
    `posts/?order=${encodeURIComponent("id asc")}&key=${DEFAULT_KEY}`,
  );
  assert.deepEqual(
    res.body.posts.map((p: { url: string }) => p.url),
    hostile,
  );
});

test("non-Ghost sites answer HTML or 404 for everything", async () => {
  const html = make({ notGhost: "html" });
  const a = await get(html, `settings/?key=${DEFAULT_KEY}`);
  assert.equal(a.status, 200);
  assert.ok(a.text.startsWith("<!doctype html>"));
  const missing = make({ notGhost: "not-found" });
  const b = await get(missing, `settings/?key=${DEFAULT_KEY}`);
  assert.equal(b.status, 404);
});

test("faults, redirects, header mutations and the before-request hook work", async () => {
  const fake = make();
  fake.rateLimitNext(7);
  const limited = await get(fake, `settings/?key=${DEFAULT_KEY}`);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "7");

  fake.redirectNext("https://evil.example/x", 1, 307);
  const moved = await get(fake, `settings/?key=${DEFAULT_KEY}`);
  assert.equal(moved.status, 307);
  assert.equal(moved.headers.get("location"), "https://evil.example/x");

  fake.mutateNext({ "x-test": "1" });
  const mutated = await get(fake, `settings/?key=${DEFAULT_KEY}`);
  assert.equal(mutated.headers.get("x-test"), "1");

  fake.failNext({ networkError: true });
  await assert.rejects(get(fake, `settings/?key=${DEFAULT_KEY}`));

  // The total changes between the first and the second request of a list.
  const changing = make({ items: manyItems(150) });
  changing.onBeforeRequest((request, f) => {
    if (request.query.page === "2") f.state.items.pop();
  });
  const one = await get(changing, `posts/?limit=100&page=1&key=${DEFAULT_KEY}`);
  const two = await get(changing, `posts/?limit=100&page=2&key=${DEFAULT_KEY}`);
  assert.equal(one.body.meta.pagination.total, 150);
  assert.equal(two.body.meta.pagination.total, 149);
});

test("requests to another host are recorded and answered 404", async () => {
  const fake = make();
  const response = await fake.fetch(
    `https://evil.example/ghost/api/content/posts/?key=${DEFAULT_KEY}`,
  );
  assert.equal(response.status, 404);
  assert.equal(fake.requests.at(-1)!.host, "evil.example");
});
