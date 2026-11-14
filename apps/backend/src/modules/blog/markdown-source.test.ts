import assert from "node:assert/strict";
import { test } from "vitest";
import { parseMarkdownPost, validateMarkdownPosts } from "./markdown-source";

const file = (frontMatter: string, body = "## Hello\n\nBody.") =>
  `---\n${frontMatter}\n---\n\n${body}\n`;

const base = [
  "articleId: what-is-mcp",
  "locale: zh-CN",
  "slug: what-is-mcp-zh-cn",
  "title: 什么是 MCP？",
  "excerpt: 一句话摘要。",
].join("\n");

test("reads the fields and applies the same fallbacks as a Notion row", () => {
  const post = parseMarkdownPost(
    file(
      `${base}\nstatus: published\npublishedAt: 2026-11-15\nauthor: SourceWeft\ncategory: Guides\ntags: [MCP, Agent Skills]\nfeatured: true`,
    ),
    "01/zh-CN.md",
  );
  assert.equal(post.articleId, "what-is-mcp");
  assert.equal(post.locale, "zh-CN");
  assert.equal(post.slug, "what-is-mcp-zh-cn");
  assert.equal(post.status, "published");
  assert.equal(post.seoTitle, "什么是 MCP？");
  assert.equal(post.seoDescription, "一句话摘要。");
  assert.equal(post.authorName, "SourceWeft");
  assert.deepEqual(post.tags, ["MCP", "Agent Skills"]);
  assert.equal(post.featured, true);
  assert.equal(post.publishedAt?.toISOString().slice(0, 10), "2026-11-15");
  assert.equal(post.body, "## Hello\n\nBody.");
});

test("status defaults to draft, and a draft needs no date", () => {
  const post = parseMarkdownPost(file(base), "a.md");
  assert.equal(post.status, "draft");
  assert.equal(post.publishedAt, null);
});

test("locale is matched without regard to case", () => {
  const post = parseMarkdownPost(file(base.replace("zh-CN", "zh-cn")), "a.md");
  assert.equal(post.locale, "zh-CN");
});

test("every problem in a file is reported together, with its path", () => {
  assert.throws(
    () =>
      parseMarkdownPost(
        file(
          "locale: fr\nslug: a/b\ntitle: T\nstatus: live\ntags: MCP\nfeatured: yes please\nextra: 1",
          "",
        ),
        "bad/en.md",
      ),
    (error: Error) => {
      for (const expected of [
        "bad/en.md",
        "articleId is required",
        "locale must be one of",
        "slug is required",
        "excerpt is required",
        "status must be one of",
        "tags must be a list of strings",
        "featured must be true or false",
        "Unknown front matter field: extra",
        "The article body is empty",
      ]) {
        assert.ok(error.message.includes(expected), expected);
      }
      return true;
    },
  );
});

test("a published article needs a date", () => {
  assert.throws(
    () => parseMarkdownPost(file(`${base}\nstatus: published`), "a.md"),
    /publishedAt is required when status is published/,
  );
});

test("canonicalUrl follows the Notion rule", () => {
  assert.throws(
    () =>
      parseMarkdownPost(
        file(`${base}\ncanonicalUrl: https://example.com/blog/x`),
        "a.md",
      ),
    /canonicalUrl must be on sourceweft.com/,
  );
  const post = parseMarkdownPost(
    file(`${base}\ncanonicalUrl: https://sourceweft.com/blog/what-is-mcp`),
    "a.md",
  );
  assert.equal(post.canonicalUrl, "https://sourceweft.com/blog/what-is-mcp");
});

test("a file without front matter is refused", () => {
  assert.throws(
    () => parseMarkdownPost("# Just a title\n", "a.md"),
    /Missing YAML front matter/,
  );
});

test("duplicate article+locale and locale+slug are refused across files", () => {
  const one = parseMarkdownPost(file(base), "one.md");
  const sameArticle = parseMarkdownPost(
    file(base.replace("what-is-mcp-zh-cn", "other-slug")),
    "two.md",
  );
  const sameSlug = parseMarkdownPost(
    file(base.replace("articleId: what-is-mcp", "articleId: other")),
    "three.md",
  );
  assert.throws(
    () => validateMarkdownPosts([one, sameArticle]),
    /Duplicate articleId \+ locale what-is-mcp:zh-CN: one.md and two.md/,
  );
  assert.throws(
    () => validateMarkdownPosts([one, sameSlug]),
    /Duplicate locale \+ slug zh-CN:what-is-mcp-zh-cn: one.md and three.md/,
  );
  // The same slug in another language is a different row.
  const english = parseMarkdownPost(
    file(base.replace("locale: zh-CN", "locale: en").replace("articleId: what-is-mcp", "articleId: other")),
    "four.md",
  );
  validateMarkdownPosts([one, english]);
});
