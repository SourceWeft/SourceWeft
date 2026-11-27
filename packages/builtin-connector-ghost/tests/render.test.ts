import assert from "node:assert/strict";
import test from "node:test";
import { HTML_TO_MARKDOWN_MAX_INPUT_CHARS } from "@sourceweft/html-text";
import { GhostError } from "../src/errors";
import { MAX_TEXT_CHARS } from "../src/limits";
import { type GhostItem } from "../src/model";
import { renderContent } from "../src/render";

const SITE_HOST = "site.example";

function item(overrides: Partial<GhostItem> = {}): GhostItem {
  return {
    id: "5ddc9141c35e7700383b2937",
    type: "post",
    slug: "hello",
    url: "https://site.example/hello/",
    title: "Hello",
    updatedAt: "2026-01-02T03:04:05.000Z",
    publishedAt: "2026-01-01T00:00:00.000Z",
    visibility: "public",
    access: true,
    canonicalUrl: null,
    tags: [{ id: "a".repeat(24), slug: "news", name: "News" }],
    html: "<p>First paragraph.</p><p>Second.</p>",
    authors: ["Ann"],
    ...overrides,
  };
}

test("renders the heading, the metadata list and the body", () => {
  assert.equal(
    renderContent(item(), SITE_HOST),
    [
      "# Hello",
      "",
      "- Type: Post",
      "- Tags: News",
      "- Authors: Ann",
      "- Published: 2026-01-01T00:00:00.000Z",
      "- Updated: 2026-01-02T03:04:05.000Z",
      "- URL: https://site.example/hello/",
      "",
      "First paragraph.",
      "",
      "Second.",
    ].join("\n"),
  );
});

test("a page without tags, authors, publish date or body leaves those out", () => {
  const markdown = renderContent(
    item({ type: "page", tags: [], authors: [], publishedAt: null, html: "" }),
    SITE_HOST,
  );
  assert.equal(
    markdown,
    [
      "# Hello",
      "",
      "- Type: Page",
      "- Updated: 2026-01-02T03:04:05.000Z",
      "- URL: https://site.example/hello/",
    ].join("\n"),
  );
});

test("Canonical URL is shown only when set", () => {
  assert.ok(!renderContent(item(), SITE_HOST).includes("Canonical URL"));
  const markdown = renderContent(
    item({ canonicalUrl: "https://example.org/original/" }),
    SITE_HOST,
  );
  assert.ok(
    markdown.includes("- Canonical URL: https://example.org/original/"),
  );
});

test("an empty title renders as Untitled", () => {
  assert.ok(
    renderContent(item({ title: "" }), SITE_HOST).startsWith("# Untitled\n"),
  );
});

test("hostile titles, tags and authors stay on one line and cannot form blocks or links", () => {
  const nasty = "x\n\n## Post\n---\n[click](https://evil.example) <b>";
  const markdown = renderContent(
    item({
      title: nasty,
      tags: [{ id: "a".repeat(24), slug: "t", name: nasty }],
      authors: [nasty],
      canonicalUrl: "https://e.example/\n## Forged\n[a](b)",
    }),
    SITE_HOST,
  );
  const lines = markdown.split("\n");
  const body = lines.indexOf("First paragraph.");
  const header = lines.slice(0, body - 1);
  // Exactly the heading, a blank, then one line per metadata row.
  assert.equal(header[0]!.startsWith("# "), true);
  assert.equal(header[1], "");
  for (const row of header.slice(2)) assert.match(row, /^- [A-Za-z ]+: /);
  assert.equal(header.length, 2 + 7);
  assert.ok(!lines.some((line) => /^#{2,}\s/.test(line)));
  assert.ok(!lines.includes("---"));
  // No live link or autolink syntax from any value.
  for (const line of header) {
    assert.ok(!/(^|[^\\])\[[^\]]*\]\(/.test(line), line);
    assert.ok(!/(^|[^\\])</.test(line), line);
  }
});

test("a hostile body is converted by htmlToMarkdown, not copied", () => {
  const markdown = renderContent(
    item({
      html: '<script>alert(1)</script><h2>Section</h2><p onclick="x()">Text <a href="https://a.example/">link</a></p><style>p{}</style>',
    }),
    SITE_HOST,
  );
  assert.ok(!markdown.includes("alert(1)"));
  assert.ok(!markdown.includes("onclick"));
  assert.ok(!markdown.includes("p{}"));
  assert.ok(markdown.includes("## Section"));
  assert.ok(markdown.includes("[link](https://a.example/)"));
});

test("a huge body is cut at MAX_TEXT_CHARS with a final truncation line", () => {
  const html = Array.from(
    { length: 20_000 },
    (_, i) => `<p>${i} ${"word ".repeat(10)}</p>`,
  ).join("");
  const markdown = renderContent(item({ html }), SITE_HOST);
  assert.ok(markdown.length <= MAX_TEXT_CHARS);
  assert.ok(markdown.length > MAX_TEXT_CHARS - 1_000);
  assert.equal(markdown.split("\n").at(-1), "[Content truncated]");
  assert.ok(markdown.startsWith("# Hello\n"));
});

test("a small cap is respected and the marker still ends the text", () => {
  const markdown = renderContent(
    item({ html: `<p>${"a".repeat(1_000)}</p>` }),
    SITE_HOST,
    300,
  );
  assert.ok(markdown.length <= 300);
  assert.equal(markdown.split("\n").at(-1), "[Content truncated]");
  assert.throws(() => renderContent(item(), SITE_HOST, 10), RangeError);
});

test("input past the converter's ceiling is a truncation even when the text is short", () => {
  const html = `<p>short</p>${" ".repeat(HTML_TO_MARKDOWN_MAX_INPUT_CHARS)}<p>unseen</p>`;
  const markdown = renderContent(item({ html }), SITE_HOST);
  assert.equal(markdown.split("\n").at(-1), "[Content truncated]");
  assert.ok(!markdown.includes("unseen"));
});

test("an item the key cannot read in full is never rendered", () => {
  assert.throws(
    () => renderContent(item({ access: false, visibility: "paid" }), SITE_HOST),
    (error: unknown) =>
      error instanceof GhostError && error.code === "BAD_RESPONSE",
  );
});

test("a hostile url is LINK_INVALID", () => {
  assert.throws(
    () => renderContent(item({ url: "javascript:alert(1)" }), SITE_HOST),
    (error: unknown) =>
      error instanceof GhostError && error.code === "LINK_INVALID",
  );
});
