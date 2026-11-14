import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock("./repository", () => ({
  BLOG_SOURCE_MARKDOWN: "markdown",
  buildBlogPostId: (articleId: string, locale: string) =>
    `post_${articleId}_${locale}`,
  upsertBlogPost: mocks.upsert,
}));

import { importMarkdownBlog } from "./import-markdown";

let dir = "";

const article = (fields: string, body = "## Hello\n\nA [link](https://sourceweft.com/mcp).") =>
  `---\n${fields}\n---\n\n${body}\n`;

beforeEach(async () => {
  mocks.upsert.mockReset();
  dir = await mkdtemp(join(tmpdir(), "blog-import-"));
  await mkdir(join(dir, "01-what-is-mcp"), { recursive: true });
  await writeFile(
    join(dir, "01-what-is-mcp", "en.md"),
    article(
      "articleId: what-is-mcp\nlocale: en\nslug: what-is-mcp\ntitle: What is MCP?\nexcerpt: An open protocol.\nstatus: published\npublishedAt: 2026-11-15\ntags: [MCP]",
    ),
  );
  await writeFile(
    join(dir, "01-what-is-mcp", "zh-CN.md"),
    article(
      "articleId: what-is-mcp\nlocale: zh-CN\nslug: what-is-mcp-zh-cn\ntitle: 什么是 MCP？\nexcerpt: 一个开放协议。",
    ),
  );
  await writeFile(join(dir, "notes.txt"), "not an article");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("writes one row per file, marked as Markdown-sourced", async () => {
  const result = await importMarkdownBlog({ dir });

  assert.deepEqual(
    { scanned: result.scanned, upserted: result.upserted, published: result.published },
    { scanned: 2, upserted: 2, published: 1 },
  );
  assert.equal(mocks.upsert.mock.calls.length, 2);
  const english = mocks.upsert.mock.calls[0]?.[0];
  assert.equal(english.id, "post_what-is-mcp_en");
  assert.equal(english.slug, "what-is-mcp");
  assert.equal(english.status, "published");
  assert.equal(english.syncEnabled, true);
  assert.equal(
    english.contentHtml,
    '<h2 id="hello">Hello</h2>\n<p>A <a href="https://sourceweft.com/mcp">link</a>.</p>',
  );
  assert.equal(english.metadataJson.source, "markdown");
  assert.equal(english.ogImageAssetId, null);
  const chinese = mocks.upsert.mock.calls[1]?.[0];
  assert.equal(chinese.status, "draft");
  assert.equal(chinese.locale, "zh-CN");
});

test("--dry-run and --validate-only write nothing", async () => {
  const dry = await importMarkdownBlog({ dir, dryRun: true });
  assert.equal(dry.upserted, 2);
  const validated = await importMarkdownBlog({ dir, validateOnly: true });
  assert.equal(validated.upserted, 0);
  assert.equal(validated.validated, 2);
  assert.equal(mocks.upsert.mock.calls.length, 0);
});

test("one bad file fails the run before anything is written", async () => {
  await writeFile(
    join(dir, "bad.md"),
    article("articleId: x\nlocale: en\nslug: x\ntitle: X\nexcerpt: X", "![img](https://sourceweft.com/a.png)"),
  );
  await assert.rejects(
    importMarkdownBlog({ dir }),
    /bad\.md: Images are not supported/,
  );
  assert.equal(mocks.upsert.mock.calls.length, 0);
});

test("an empty directory is an error, not a silent no-op", async () => {
  const empty = await mkdtemp(join(tmpdir(), "blog-import-empty-"));
  try {
    await assert.rejects(importMarkdownBlog({ dir: empty }), /No \.md files found/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
