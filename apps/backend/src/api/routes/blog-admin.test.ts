import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createRouteTestApp, readJson } from "../../test/hono";

// The admin's blog routes: who may call them, what an import writes and
// refuses, and what publishing does.
const mocks = vi.hoisted(() => ({
  admin: true,
  signedIn: true,
  listBlogPostsForAdmin: vi.fn(),
  getBlogPostForAdmin: vi.fn(),
  setBlogPostStatus: vi.fn(),
  getBlogPostStates: vi.fn(),
  upsertBlogPost: vi.fn(),
}));

vi.mock("../middleware/auth-session", async () =>
  (await import("../../test/hono")).signedInWhen("admin_1", mocks),
);
vi.mock("../../modules/market/admin", () => ({
  isMarketAdmin: () => mocks.admin,
}));
vi.mock("../../modules/blog/repository", () => ({
  BLOG_SOURCE_MARKDOWN: "markdown",
  buildBlogPostId: (articleId: string, locale: string) =>
    `post_${articleId}_${locale}`,
  getBlogPostForAdmin: mocks.getBlogPostForAdmin,
  getBlogPostStates: mocks.getBlogPostStates,
  listBlogPostsForAdmin: mocks.listBlogPostsForAdmin,
  setBlogPostStatus: mocks.setBlogPostStatus,
  upsertBlogPost: mocks.upsertBlogPost,
}));

import { registerBlogAdminRoutes } from "./blog-admin";

const createTestApp = () => createRouteTestApp(registerBlogAdminRoutes);
const base = "/v1/blog/admin";
const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const row = {
  id: "post_what-is-mcp_en",
  articleId: "what-is-mcp",
  locale: "en",
  slug: "what-is-mcp",
  status: "draft",
  syncEnabled: true,
  title: "What is MCP?",
  excerpt: "An open protocol.",
  category: "Guides",
  tags: ["MCP"],
  readingTimeMinutes: 5,
  publishedAt: null,
  syncedAt: new Date("2026-11-15T01:00:00.000Z"),
  source: "markdown",
};

const article = (fields: string, bodyText = "## Hello\n\nBody.") =>
  `---\n${fields}\n---\n\n${bodyText}\n`;
const english = {
  path: "01/en.md",
  content: article(
    "articleId: what-is-mcp\nlocale: en\nslug: what-is-mcp\ntitle: What is MCP?\nexcerpt: An open protocol.\nstatus: draft",
  ),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin = true;
  mocks.signedIn = true;
  mocks.listBlogPostsForAdmin.mockResolvedValue([row]);
  mocks.getBlogPostForAdmin.mockResolvedValue({ ...row, contentHtml: "<p>Body.</p>" });
  mocks.setBlogPostStatus.mockResolvedValue({
    ...row,
    status: "published",
    publishedAt: new Date("2026-11-16T00:00:00.000Z"),
    contentHtml: "<p>Body.</p>",
  });
  mocks.getBlogPostStates.mockResolvedValue(new Map());
});

test("every route is 401 signed out and 403 for a non-admin", async () => {
  const requests: Array<[string, RequestInit?]> = [
    [`${base}/posts`],
    [`${base}/posts/post_1`],
    [`${base}/posts/post_1/status`, json({ status: "published" })],
    [`${base}/import`, json({ files: [english] })],
  ];

  mocks.signedIn = false;
  for (const [path, init] of requests) {
    assert.equal((await createTestApp().request(path, init)).status, 401, path);
  }
  mocks.signedIn = true;
  mocks.admin = false;
  for (const [path, init] of requests) {
    assert.equal((await createTestApp().request(path, init)).status, 403, path);
  }
  assert.equal(mocks.upsertBlogPost.mock.calls.length, 0);
  assert.equal(mocks.setBlogPostStatus.mock.calls.length, 0);
});

test("lists every post with dates as ISO strings and its source", async () => {
  const response = await createTestApp().request(`${base}/posts`);
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.deepEqual(body.items, [
    { ...row, syncedAt: "2026-11-15T01:00:00.000Z" },
  ]);
});

test("reads one post with its rendered body; an unknown id is 404", async () => {
  const found = await createTestApp().request(`${base}/posts/${row.id}`);
  assert.equal(found.status, 200);
  assert.equal((await readJson(found)).contentHtml, "<p>Body.</p>");

  mocks.getBlogPostForAdmin.mockResolvedValueOnce(null);
  assert.equal(
    (await createTestApp().request(`${base}/posts/missing`)).status,
    404,
  );
});

test("sets a status; a bad status is 400 and an unknown post is 404", async () => {
  const published = await createTestApp().request(
    `${base}/posts/${row.id}/status`,
    json({ status: "published" }),
  );
  assert.equal(published.status, 200);
  assert.deepEqual(mocks.setBlogPostStatus.mock.calls[0]?.[0], {
    id: row.id,
    status: "published",
  });
  const body = await readJson(published);
  assert.equal(body.status, "published");
  assert.equal(body.publishedAt, "2026-11-16T00:00:00.000Z");

  const bad = await createTestApp().request(
    `${base}/posts/${row.id}/status`,
    json({ status: "live" }),
  );
  assert.equal(bad.status, 400);

  mocks.setBlogPostStatus.mockResolvedValueOnce(null);
  const missing = await createTestApp().request(
    `${base}/posts/missing/status`,
    json({ status: "draft" }),
  );
  assert.equal(missing.status, 404);
});

test("an import writes new posts with their file's status", async () => {
  const response = await createTestApp().request(
    `${base}/import`,
    json({ files: [english] }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), {
    dryRun: false,
    posts: [
      {
        path: "01/en.md",
        articleId: "what-is-mcp",
        locale: "en",
        slug: "what-is-mcp",
        title: "What is MCP?",
        created: true,
      },
    ],
  });
  const written = mocks.upsertBlogPost.mock.calls[0]?.[0];
  assert.equal(written.id, "post_what-is-mcp_en");
  assert.equal(written.status, "draft");
  assert.equal(written.contentHtml, '<h2 id="hello">Hello</h2>\n<p>Body.</p>');
  assert.equal(written.metadataJson.source, "markdown");
});

test("an import keeps an existing post's status and publish date", async () => {
  const publishedAt = new Date("2026-11-16T00:00:00.000Z");
  mocks.getBlogPostStates.mockResolvedValue(
    new Map([["post_what-is-mcp_en", { status: "published", publishedAt }]]),
  );

  const response = await createTestApp().request(
    `${base}/import`,
    // The uploaded file still says draft; the live article must stay live.
    json({ files: [english] }),
  );
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal((body.posts as Array<{ created: boolean }>)[0]?.created, false);
  const written = mocks.upsertBlogPost.mock.calls[0]?.[0];
  assert.equal(written.status, "published");
  assert.equal(written.publishedAt, publishedAt);
});

test("a dry run validates and writes nothing", async () => {
  const response = await createTestApp().request(
    `${base}/import`,
    json({ files: [english], dryRun: true }),
  );
  assert.equal(response.status, 200);
  assert.equal((await readJson(response)).dryRun, true);
  assert.equal(mocks.upsertBlogPost.mock.calls.length, 0);
  assert.equal(mocks.getBlogPostStates.mock.calls.length, 0);
});

test("one invalid file fails the whole import with per-file problems", async () => {
  const response = await createTestApp().request(
    `${base}/import`,
    json({
      files: [
        english,
        { path: "bad.md", content: article("locale: en\nslug: x\ntitle: X") },
      ],
    }),
  );
  assert.equal(response.status, 400);
  const body = await readJson(response);
  assert.equal(body.code, "VALIDATION_ERROR");
  const problems = (body.details as { problems: Array<{ path: string; message: string }> }).problems;
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.path, "bad.md");
  assert.match(problems[0]?.message ?? "", /articleId is required/);
  assert.match(problems[0]?.message ?? "", /excerpt is required/);
  assert.equal(mocks.upsertBlogPost.mock.calls.length, 0);
});

test("duplicate article+locale across uploaded files is refused", async () => {
  const response = await createTestApp().request(
    `${base}/import`,
    json({ files: [english, { ...english, path: "copy/en.md" }] }),
  );
  assert.equal(response.status, 400);
  const body = await readJson(response);
  const problems = (body.details as { problems: Array<{ message: string }> }).problems;
  assert.match(problems[0]?.message ?? "", /Duplicate articleId \+ locale/);
  assert.equal(mocks.upsertBlogPost.mock.calls.length, 0);
});

test("an empty or malformed request body is 400", async () => {
  assert.equal(
    (await createTestApp().request(`${base}/import`, json({ files: [] }))).status,
    400,
  );
  const notJson = await createTestApp().request(`${base}/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(notJson.status, 400);
});
