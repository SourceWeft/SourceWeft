import assert from "node:assert/strict";
import test from "node:test";
import { createWordPressClient, type WordPressClient } from "../src/client";
import { WordPressError, type WordPressRestCode } from "../src/errors";
import { MAX_CATEGORY_PAGES, MAX_TAG_IDS, PER_PAGE } from "../src/limits";
import {
  createFakeWordPress,
  type FakePost,
  type FakeWordPress,
  type FakeWordPressOptions,
} from "./helpers/fake-wordpress";

const SITE = "https://site.example";
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

async function failure(promise: Promise<unknown>): Promise<WordPressError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof WordPressError, String(error));
    return error;
  }
  assert.fail("expected a WordPressError");
}

function posts(count: number, extra: Partial<FakePost> = {}): FakePost[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    title: `Post ${i + 1}`,
    ...extra,
  }));
}

function onRest(request: { path: string }): boolean {
  return request.path.includes("/wp/v2/");
}

function restRequests(fake: FakeWordPress) {
  return fake.requests.filter((r) => r.path.includes("/wp/v2/"));
}

const LIST_FIELDS =
  "id,modified_gmt,link,title,status,type,categories,tags,author";

// ------------------------------------------------------------- listItems

test("listItems asks for a stable, trimmed page and never sends status", async () => {
  const { fake, client } = harness({ fake: { posts: posts(3) } });
  const result = await client.listItems("posts", {
    page: 1,
    includeUnpublished: false,
  });
  assert.equal(result.items.length, 3);
  assert.equal(result.total, 3);
  assert.equal(result.totalPages, 1);
  assert.equal(result.items[0]?.title, "Post 1");
  assert.equal(result.items[0]?.link, `${SITE}/?p=1`);
  const [request] = restRequests(fake);
  assert.deepEqual(request?.query, {
    per_page: String(PER_PAGE),
    page: "1",
    orderby: "id",
    order: "asc",
    _fields: LIST_FIELDS,
  });
  assert.equal("status" in (request?.query ?? {}), false);
});

test("listItems filters by categories on posts and rejects them on pages", async () => {
  const { fake, client } = harness({
    fake: {
      posts: [
        { id: 1, categories: [10] },
        { id: 2, categories: [11] },
        { id: 3, categories: [12] },
      ],
    },
  });
  const result = await client.listItems("posts", {
    page: 1,
    categories: [10, 12],
    includeUnpublished: false,
  });
  assert.deepEqual(
    result.items.map((i) => i.id),
    [1, 3],
  );
  assert.equal(restRequests(fake)[0]?.query.categories, "10,12");
  for (const bad of [[], [0], [-1], [1.5]]) {
    const error = await failure(
      client.listItems("posts", {
        page: 1,
        categories: bad,
        includeUnpublished: false,
      }),
    );
    assert.equal(error.code, "CONFIG_INVALID");
  }
  const pages = await failure(
    client.listItems("pages", {
      page: 1,
      categories: [10],
      includeUnpublished: false,
    }),
  );
  assert.equal(pages.code, "CONFIG_INVALID");
  const page0 = await failure(
    client.listItems("posts", { page: 0, includeUnpublished: false }),
  );
  assert.equal(page0.code, "CONFIG_INVALID");
});

test("listItems pages through a route and reports the totals", async () => {
  const { client } = harness({ fake: { posts: posts(250) } });
  const last = await client.listItems("posts", {
    page: 3,
    includeUnpublished: false,
  });
  assert.equal(last.items.length, 50);
  assert.equal(last.total, 250);
  assert.equal(last.totalPages, 3);
});

test("listItems reads pages with their own route and no categories", async () => {
  const { fake, client } = harness({
    fake: { posts: [{ id: 1 }, { id: 2, type: "page", title: "About" }] },
  });
  const result = await client.listItems("pages", {
    page: 1,
    includeUnpublished: false,
  });
  assert.deepEqual(
    result.items.map((i) => [i.id, i.type, i.categoryIds]),
    [[2, "page", []]],
  );
  assert.ok(restRequests(fake)[0]?.path.endsWith("/wp/v2/pages"));
});

test("listItems with includeUnpublished sends the full status list", async () => {
  const { fake, client } = harness({
    login: true,
    fake: {
      posts: [
        { id: 1 },
        { id: 2, status: "draft" },
        { id: 3, status: "private" },
      ],
    },
  });
  const result = await client.listItems("posts", {
    page: 1,
    includeUnpublished: true,
  });
  assert.deepEqual(
    result.items.map((i) => i.status),
    ["publish", "draft", "private"],
  );
  assert.equal(
    restRequests(fake)[0]?.query.status,
    "publish,private,draft,pending,future",
  );
});

test("listItems with includeUnpublished maps a forbidden status to INSUFFICIENT_PERMISSION", async () => {
  // No credential: the fake answers 400 rest_invalid_param / rest_forbidden_status.
  const { client } = harness({ fake: { posts: posts(1) } });
  const error = await failure(
    client.listItems("posts", { page: 1, includeUnpublished: true }),
  );
  assert.equal(error.code, "INSUFFICIENT_PERMISSION");
  assert.equal(error.restCode, undefined);
});

test("listItems maps rights-lacking 401/403 only when unpublished content was asked for", async () => {
  const restCodes: WordPressRestCode[] = [
    "rest_cannot_view",
    "rest_forbidden",
    "rest_user_cannot_view",
  ];
  for (const status of [401, 403]) {
    for (const code of restCodes) {
      const body = JSON.stringify({ code });
      const open = harness({ login: true, fake: { posts: posts(1) } });
      open.fake.failNext({ status, body }, 1, onRest);
      const mapped = await failure(
        open.client.listItems("posts", { page: 1, includeUnpublished: true }),
      );
      assert.equal(mapped.code, "INSUFFICIENT_PERMISSION", `${status} ${code}`);

      const plain = harness({ login: true, fake: { posts: posts(1) } });
      plain.fake.failNext({ status, body }, 1, onRest);
      const passed = await failure(
        plain.client.listItems("posts", {
          page: 1,
          includeUnpublished: false,
        }),
      );
      assert.equal(passed.code, "LOGIN_REQUIRED", `${status} ${code}`);
      assert.equal(passed.restCode, code);
    }
  }
});

test("listItems lets wrong credentials and login walls through unchanged", async () => {
  const wrong = harness({ login: true, fake: { posts: posts(1) } });
  wrong.fake.failNext(
    { status: 401, body: JSON.stringify({ code: "incorrect_password" }) },
    1,
    onRest,
  );
  assert.equal(
    (
      await failure(
        wrong.client.listItems("posts", { page: 1, includeUnpublished: true }),
      )
    ).code,
    "BAD_CREDENTIALS",
  );
  const walled = harness({
    login: true,
    fake: { posts: posts(1), loginRequired: true },
  });
  assert.equal(
    (
      await failure(
        walled.client.listItems("posts", { page: 1, includeUnpublished: true }),
      )
    ).code,
    "LOGIN_REQUIRED",
  );
});

test("listItems throws BAD_RESPONSE on a malformed answer", async () => {
  const cases: Record<string, (h: Harness) => void> = {
    "body is not an array": (h) =>
      h.fake.failNext({ status: 200, body: JSON.stringify({ a: 1 }) }, 1, (r) =>
        r.path.endsWith("/posts"),
      ),
    "an item has a wrong shape": (h) =>
      h.fake.failNext(
        {
          status: 200,
          headers: { "X-WP-Total": "1", "X-WP-TotalPages": "1" },
          body: JSON.stringify([{ id: "x" }]),
        },
        1,
        (r) => r.path.endsWith("/posts"),
      ),
    "paging headers are missing": (h) =>
      h.fake.failNext({ status: 200, body: "[]" }, 1, (r) =>
        r.path.endsWith("/posts"),
      ),
    "a page answers more than a page": (h) =>
      h.fake.failNext(
        {
          status: 200,
          headers: { "X-WP-Total": "1", "X-WP-TotalPages": "1" },
          body: JSON.stringify(
            Array.from({ length: PER_PAGE + 1 }, (_, i) => ({
              id: i + 1,
              type: "post",
              status: "publish",
              link: `${SITE}/?p=${i + 1}`,
              modified_gmt: "2026-01-01T00:00:00",
              title: { rendered: "x" },
            })),
          ),
        },
        1,
        (r) => r.path.endsWith("/posts"),
      ),
    "a post item appears on the pages route": (h) =>
      h.fake.failNext(
        {
          status: 200,
          headers: { "X-WP-Total": "1", "X-WP-TotalPages": "1" },
          body: JSON.stringify([
            {
              id: 1,
              type: "post",
              status: "publish",
              link: `${SITE}/?p=1`,
              modified_gmt: "2026-01-01T00:00:00",
              title: { rendered: "x" },
            },
          ]),
        },
        1,
        (r) => r.path.endsWith("/pages"),
      ),
    "the route does not exist": (h) =>
      h.fake.failNext({ status: 404, body: "{}" }, 1, (r) =>
        r.path.endsWith("/posts"),
      ),
  };
  for (const [label, arrange] of Object.entries(cases)) {
    const h = harness({ fake: { posts: posts(1) } });
    arrange(h);
    const route = label.includes("pages route") ? "pages" : "posts";
    const error = await failure(
      h.client.listItems(route, { page: 1, includeUnpublished: false }),
    );
    assert.equal(error.code, "BAD_RESPONSE", label);
  }
});

// --------------------------------------------------------------- getItem

test("getItem reads one item with its body and asks only for fixed fields", async () => {
  const { fake, client } = harness({
    fake: {
      posts: [
        {
          id: 9,
          title: "Nine",
          content: "<p>Nine body</p>",
          categories: [3],
          tags: [4],
          slug: "nine",
        },
      ],
    },
  });
  const post = await client.getItem("posts", 9, false);
  assert.ok(post);
  assert.equal(post.id, 9);
  assert.equal(post.contentHtml, "<p>Nine body</p>");
  assert.equal(post.slug, "nine");
  assert.equal(post.protected, false);
  assert.deepEqual(post.categoryIds, [3]);
  const [request] = restRequests(fake);
  assert.ok(request?.path.endsWith("/wp/v2/posts/9"));
  assert.deepEqual(request?.query, {
    _fields: `${LIST_FIELDS},content,slug,date_gmt`,
  });
});

test("getItem returns null for a missing item and reads pages", async () => {
  const { client } = harness({
    fake: { posts: [{ id: 3, type: "page", title: "About" }] },
  });
  assert.equal(await client.getItem("posts", 404, false), null);
  assert.equal(await client.getItem("posts", 3, false), null);
  const page = await client.getItem("pages", 3, false);
  assert.equal(page?.type, "page");
});

test("getItem returns a protected post as such", async () => {
  const { client } = harness({
    fake: { posts: [{ id: 5, protected: true }] },
  });
  const post = await client.getItem("posts", 5, false);
  assert.equal(post?.protected, true);
  assert.equal(post?.contentHtml, "");
});

test("getItem never sends status and does not hand back unpublished content unasked", async () => {
  const draft: FakePost = { id: 6, status: "draft", title: "Draft" };
  const open = harness({ login: true, fake: { posts: [draft] } });
  assert.equal(await open.client.getItem("posts", 6, false), null);
  assert.equal(
    restRequests(open.fake).every((r) => !("status" in r.query)),
    true,
  );
  const wanted = await open.client.getItem("posts", 6, true);
  assert.equal(wanted?.status, "draft");
  assert.equal(
    restRequests(open.fake).every((r) => !("status" in r.query)),
    true,
  );
});

test("getItem maps rights errors only when unpublished content was asked for", async () => {
  const anon = harness({ fake: { posts: [{ id: 6, status: "draft" }] } });
  const passed = await failure(anon.client.getItem("posts", 6, false));
  assert.equal(passed.code, "LOGIN_REQUIRED");
  assert.equal(passed.restCode, "rest_forbidden");
  const anon2 = harness({ fake: { posts: [{ id: 6, status: "draft" }] } });
  const mapped = await failure(anon2.client.getItem("posts", 6, true));
  assert.equal(mapped.code, "INSUFFICIENT_PERMISSION");
});

test("getItem throws BAD_RESPONSE for the wrong item or shape", async () => {
  const h = harness({ fake: { posts: [{ id: 7 }] } });
  h.fake.failNext(
    {
      status: 200,
      body: JSON.stringify({
        id: 8,
        type: "post",
        status: "publish",
        link: `${SITE}/?p=8`,
        modified_gmt: "2026-01-01T00:00:00",
        title: { rendered: "x" },
        content: { rendered: "", protected: false },
        slug: "x",
        date_gmt: "2026-01-01T00:00:00",
      }),
    },
    1,
    (r) => r.path.endsWith("/posts/7"),
  );
  assert.equal(
    (await failure(h.client.getItem("posts", 7, false))).code,
    "BAD_RESPONSE",
  );
  const g = harness({ fake: { posts: [{ id: 7 }] } });
  g.fake.failNext({ status: 200, body: "[]" }, 1, (r) =>
    r.path.endsWith("/posts/7"),
  );
  assert.equal(
    (await failure(g.client.getItem("posts", 7, false))).code,
    "BAD_RESPONSE",
  );
  assert.equal(
    (await failure(g.client.getItem("posts", 0, false))).code,
    "CONFIG_INVALID",
  );
});

// ----------------------------------------------------------- categories

test("listCategories reads every page", async () => {
  const categories = Array.from({ length: 230 }, (_, i) => ({
    id: i + 1,
    name: `Cat ${i + 1}`,
    parent: i === 0 ? 0 : 1,
  }));
  const { fake, client } = harness({ fake: { categories } });
  const result = await client.listCategories();
  assert.equal(result.length, 230);
  assert.deepEqual(result[1], { id: 2, name: "Cat 2", parent: 1 });
  const reqs = restRequests(fake);
  assert.equal(reqs.length, 3);
  assert.deepEqual(reqs[0]?.query, {
    per_page: String(PER_PAGE),
    page: "1",
    orderby: "id",
    order: "asc",
    _fields: "id,name,parent",
  });
});

test("listCategories of an empty site is empty", async () => {
  const { client } = harness();
  assert.deepEqual(await client.listCategories(), []);
});

test("listCategories beyond MAX_CATEGORY_PAGES is TOO_LARGE", async () => {
  const categories = Array.from(
    { length: MAX_CATEGORY_PAGES * PER_PAGE + 1 },
    (_, i) => ({ id: i + 1, name: `C${i + 1}` }),
  );
  const { client } = harness({ fake: { categories } });
  assert.equal((await failure(client.listCategories())).code, "TOO_LARGE");
  const exact = harness({
    fake: { categories: categories.slice(0, MAX_CATEGORY_PAGES * PER_PAGE) },
  });
  assert.equal(
    (await exact.client.listCategories()).length,
    MAX_CATEGORY_PAGES * PER_PAGE,
  );
});

// ----------------------------------------------------------------- tags

test("listTags resolves ids in batches of PER_PAGE, deduplicated", async () => {
  const tags = Array.from({ length: 250 }, (_, i) => ({
    id: i + 1,
    name: `Tag ${i + 1}`,
  }));
  const { fake, client } = harness({ fake: { tags } });
  const ids = [...tags.map((t) => t.id), 1, 2, 3];
  const result = await client.listTags(ids);
  assert.equal(result.length, 250);
  assert.deepEqual(result[0], { id: 1, name: "Tag 1", parent: 0 });
  const reqs = restRequests(fake);
  assert.equal(reqs.length, 3);
  assert.equal(reqs[0]?.query.include?.split(",").length, PER_PAGE);
  assert.equal(reqs[2]?.query.include?.split(",").length, 50);
  assert.equal(reqs[0]?.query._fields, "id,name");
  assert.equal(reqs[0]?.query.per_page, String(PER_PAGE));
});

test("listTags with no ids makes no request; too many ids is TOO_LARGE", async () => {
  const { fake, client } = harness();
  assert.deepEqual(await client.listTags([]), []);
  assert.equal(restRequests(fake).length, 0);
  const ids = Array.from({ length: MAX_TAG_IDS + 1 }, (_, i) => i + 1);
  assert.equal((await failure(client.listTags(ids))).code, "TOO_LARGE");
  assert.equal(
    (await failure(client.listTags([1, -2]))).code,
    "CONFIG_INVALID",
  );
});

// ---------------------------------------------------------------- users

test("listUsers maps ids to decoded names", async () => {
  const { fake, client } = harness({
    fake: {
      users: [
        { id: 5, name: "Ann &amp; Co" },
        { id: 6, name: "Bob" },
      ],
    },
  });
  const map = await client.listUsers([5, 5, 7]);
  assert.deepEqual([...map], [[5, "Ann & Co"]]);
  const [request] = restRequests(fake);
  assert.equal(request?.query.include, "5,7");
  assert.equal(request?.query._fields, "id,name");
});

test("listUsers is best effort: 401, 403 and 404 give an empty map", async () => {
  const hidden = harness({ fake: { users: null } });
  assert.equal((await hidden.client.listUsers([5])).size, 0);
  for (const status of [403, 404]) {
    const h = harness({ fake: { users: [{ id: 5, name: "Ann" }] } });
    h.fake.failNext(
      { status, body: JSON.stringify({ code: "rest_forbidden" }) },
      1,
      (r) => r.path.endsWith("/users"),
    );
    assert.equal((await h.client.listUsers([5])).size, 0, String(status));
  }
  const none = harness();
  assert.equal((await none.client.listUsers([])).size, 0);
  assert.equal(restRequests(none.fake).length, 0);
  // A 500 is not hidden.
  const broken = harness();
  broken.fake.failNext({ status: 500 }, 3, (r) => r.path.endsWith("/users"));
  assert.equal(
    (await failure(broken.client.listUsers([5]))).code,
    "BAD_RESPONSE",
  );
});

// ------------------------------------------------------------------ me

test("getMe reads the signed-in user with edit context", async () => {
  const { fake, client } = harness({
    login: true,
    fake: {
      me: {
        id: 4,
        name: "Ann",
        capabilities: { edit_posts: true, read: true },
      },
    },
  });
  const me = await client.getMe();
  assert.deepEqual(me, {
    id: 4,
    name: "Ann",
    capabilities: { edit_posts: true, read: true },
  });
  const [request] = restRequests(fake);
  assert.ok(request?.path.endsWith("/wp/v2/users/me"));
  assert.deepEqual(request?.query, {
    context: "edit",
    _fields: "id,name,capabilities",
  });
  assert.equal(request?.headers.authorization, AUTH);
});

test("getMe without a valid login is LOGIN_REQUIRED", async () => {
  const { client } = harness();
  assert.equal((await failure(client.getMe())).code, "LOGIN_REQUIRED");
});

// --------------------------------------------------------------- search

test("searchContent searches posts and pages by title", async () => {
  const { fake, client } = harness({
    fake: {
      posts: [
        { id: 1, title: "Alpha guide" },
        { id: 2, title: "Beta" },
        { id: 3, type: "page", title: "Alpha page" },
      ],
    },
  });
  const result = await client.searchContent("  alpha ", 1);
  assert.deepEqual(
    result.items.map((i) => [i.id, i.type, i.title]),
    [
      [1, "post", "Alpha guide"],
      [3, "page", "Alpha page"],
    ],
  );
  assert.equal(result.total, 2);
  const [request] = restRequests(fake);
  assert.ok(request?.path.endsWith("/wp/v2/search"));
  assert.deepEqual(request?.query, {
    search: "alpha",
    type: "post",
    subtype: "post,page",
    per_page: String(PER_PAGE),
    page: "1",
    _fields: "id,title,url,type,subtype",
  });
});

test("searchContent sends the query as an encoded parameter", async () => {
  const { fake, client } = harness();
  await client.searchContent("a&b=c#d/../e", 2);
  const [request] = restRequests(fake);
  assert.equal(request?.query.search, "a&b=c#d/../e");
  assert.equal(request?.query.page, "2");
  assert.ok(request?.path.endsWith("/wp/v2/search"));
});

test("searchContent rejects an empty or oversized query and a bad page", async () => {
  const { client } = harness();
  for (const query of ["", "   ", "x".repeat(501)]) {
    assert.equal(
      (await failure(client.searchContent(query, 1))).code,
      "CONFIG_INVALID",
    );
  }
  assert.equal(
    (await failure(client.searchContent("a", 0))).code,
    "CONFIG_INVALID",
  );
});

// ------------------------------------------------------------ url safety

test("no helper puts response text into a request URL", async () => {
  const { fake, client } = harness({
    fake: {
      posts: [{ id: 1, title: "../../etc/passwd?x=1#y", categories: [2] }],
      categories: [{ id: 2, name: "../evil", parent: 0 }],
      tags: [{ id: 3, name: "javascript:alert(1)" }],
    },
  });
  await client.listItems("posts", { page: 1, includeUnpublished: false });
  await client.getItem("posts", 1, false);
  await client.listCategories();
  await client.listTags([3]);
  await client.listUsers([1]);
  for (const request of restRequests(fake)) {
    assert.ok(request.url.startsWith(`${SITE}/wp-json/wp/v2/`), request.url);
    assert.doesNotMatch(request.url, /evil|passwd|javascript/);
  }
});
