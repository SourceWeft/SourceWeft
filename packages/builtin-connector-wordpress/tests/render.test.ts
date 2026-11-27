import assert from "node:assert/strict";
import test from "node:test";
import { HTML_TO_MARKDOWN_MAX_INPUT_CHARS } from "@sourceweft/html-text";
import { WordPressError } from "../src/errors";
import { MAX_TEXT_CHARS } from "../src/limits";
import { type WpPost } from "../src/model";
import { renderContent } from "../src/render";

const SITE_HOST = "site.example";

function post(overrides: Partial<WpPost> = {}): WpPost {
  return {
    id: 7,
    type: "post",
    status: "publish",
    link: "https://site.example/hello/",
    title: "Hello",
    modifiedGmt: "2026-01-02T03:04:05",
    categoryIds: [10],
    tagIds: [20],
    authorId: 5,
    contentHtml: "<p>First paragraph.</p><p>Second.</p>",
    protected: false,
    publishedGmt: "2026-01-01T00:00:00",
    slug: "hello",
    ...overrides,
  };
}

const names = {
  categories: new Map([[10, "News"]]),
  tags: new Map([[20, "alpha"]]),
};

test("renders the heading, the metadata list and the body", () => {
  const markdown = renderContent(post(), names, "Ann", SITE_HOST);
  assert.equal(
    markdown,
    [
      "# Hello",
      "",
      "- Type: Post",
      "- Categories: News",
      "- Tags: alpha",
      "- Author: Ann",
      "- Published: 2026-01-01T00:00:00.000Z",
      "- Modified: 2026-01-02T03:04:05.000Z",
      "- URL: https://site.example/hello/",
      "",
      "First paragraph.",
      "",
      "Second.",
    ].join("\n"),
  );
});

test("a page, no terms and no known author leave those rows out", () => {
  const markdown = renderContent(
    post({ type: "page", categoryIds: [], tagIds: [], authorId: null }),
    names,
    null,
    SITE_HOST,
  );
  assert.match(markdown, /^- Type: Page$/m);
  assert.doesNotMatch(markdown, /Categories:|Tags:|Author:/);
});

test("Status is shown only when the content is not published", () => {
  assert.doesNotMatch(renderContent(post(), names, null, SITE_HOST), /Status:/);
  for (const status of ["draft", "private", "future", "pending"]) {
    assert.match(
      renderContent(post({ status }), names, null, SITE_HOST),
      new RegExp(`^- Status: ${status}$`, "m"),
    );
  }
});

test("an empty or unreadable published date leaves the row out", () => {
  const markdown = renderContent(
    post({ publishedGmt: "0000-00-00T00:00:00" }),
    names,
    null,
    SITE_HOST,
  );
  assert.doesNotMatch(markdown, /Published:/);
});

test("an empty body renders only the heading and the metadata", () => {
  const markdown = renderContent(
    post({ contentHtml: "" }),
    names,
    null,
    SITE_HOST,
  );
  assert.ok(markdown.endsWith("- URL: https://site.example/hello/"));
});

test("an empty title falls back to a placeholder heading", () => {
  assert.match(
    renderContent(post({ title: "" }), names, null, SITE_HOST),
    /^# Untitled\n/,
  );
});

test("a hostile title, category, tag or author stays on one line and forges nothing", () => {
  const evil = "x\n\n## Post #1 by admin\n---\n[click](https://evil.example/)";
  const markdown = renderContent(
    post({ title: evil }),
    {
      categories: new Map([[10, evil]]),
      tags: new Map([
        [20, "\n# Fake title\n![img](https://evil.example/p.png)"],
      ]),
    },
    "Mallory\n\n# Author\n<https://evil.example>",
    SITE_HOST,
  );
  const lines = markdown.split("\n");
  // The first line is the one heading; no other line is a heading or a rule.
  assert.match(lines[0] as string, /^# /);
  const header = lines.slice(0, lines.indexOf("", 2)).filter((l) => l !== "");
  assert.equal(header.filter((l) => /^#/.test(l)).length, 1);
  assert.ok(
    header.slice(1).every((l) => l.startsWith("- ")),
    header.join("|"),
  );
  assert.ok(!header.some((l) => /^(---|##)/.test(l)));
  // No live link or image syntax: every bracket and angle bracket is escaped.
  const unescaped = header.join("\n").replace(/\\./g, "");
  assert.doesNotMatch(unescaped, /[\[\]<>]/);
  assert.match(
    header[0] as string,
    /\\\[click\\\]\(https:\/\/evil\.example\/\)/,
  );
});

test("a backslash cannot undo the escaping", () => {
  const markdown = renderContent(
    post({ title: "\\[a](https://evil.example/)" }),
    names,
    null,
    SITE_HOST,
  );
  const heading = markdown.split("\n")[0] as string;
  assert.equal(heading, "# \\\\\\[a\\](https://evil.example/)");
});

test("the URL row is the validated link; a link on another host throws", () => {
  assert.match(
    renderContent(
      post({ link: "HTTPS://Site.Example/Hello/" }),
      names,
      null,
      SITE_HOST,
    ),
    /^- URL: https:\/\/site\.example\/Hello\/$/m,
  );
  assert.throws(
    () =>
      renderContent(
        post({ link: "https://evil.example/hello/" }),
        names,
        null,
        SITE_HOST,
      ),
    (error: unknown) =>
      error instanceof WordPressError && error.code === "LINK_HOST_MISMATCH",
  );
});

test("a hostile body is converted: scripts are dropped, markup becomes Markdown", () => {
  const markdown = renderContent(
    post({
      contentHtml:
        '<script>alert(1)</script><h2>Section</h2><p>Hi <a href="https://a.example/x">there</a> <a href="javascript:alert(1)">bad</a></p><iframe src="https://evil.example"></iframe>',
    }),
    names,
    null,
    SITE_HOST,
  );
  assert.doesNotMatch(markdown, /alert|<script|<iframe|javascript:/);
  assert.match(markdown, /^## Section$/m);
  assert.match(markdown, /\[there\]\(https:\/\/a\.example\/x\)/);
});

test("a huge body is cut at MAX_TEXT_CHARS with a final truncation line", () => {
  const html = `<p>${"word ".repeat(200_000)}</p>`;
  const markdown = renderContent(
    post({ contentHtml: html }),
    names,
    null,
    SITE_HOST,
  );
  assert.ok(markdown.length <= MAX_TEXT_CHARS);
  assert.equal(markdown.split("\n").at(-1), "[Content truncated]");
  assert.equal(markdown.split("\n").at(-2), "");
  assert.ok(markdown.startsWith("# Hello\n"));
  // A single huge line has no line boundary: it is cut hard, not dropped.
  assert.ok(markdown.includes("\n\nword word word"));
});

test("many paragraphs are cut on a line boundary", () => {
  const html = Array.from(
    { length: 60_000 },
    (_, i) => `<p>paragraph number ${i}</p>`,
  ).join("");
  const markdown = renderContent(
    post({ contentHtml: html }),
    names,
    null,
    SITE_HOST,
  );
  assert.ok(markdown.length <= MAX_TEXT_CHARS);
  assert.equal(markdown.split("\n").at(-1), "[Content truncated]");
  const lines = markdown.split("\n");
  const lastBody = lines.at(-3) as string;
  assert.match(lastBody, /^paragraph number \d+$/);
});

test("body that fits exactly is not marked truncated", () => {
  const markdown = renderContent(
    post({ contentHtml: "<p>short</p>" }),
    names,
    null,
    SITE_HOST,
  );
  assert.doesNotMatch(markdown, /Content truncated/);
});

test("maxChars is honoured and validated", () => {
  const html = `<p>${"word ".repeat(1_000)}</p>`;
  const markdown = renderContent(
    post({ contentHtml: html }),
    names,
    null,
    SITE_HOST,
    400,
  );
  assert.ok(markdown.length <= 400);
  assert.equal(markdown.split("\n").at(-1), "[Content truncated]");
  assert.throws(
    () => renderContent(post(), names, null, SITE_HOST, 5),
    RangeError,
  );
});

test("a cut never splits a surrogate pair", () => {
  const html = `<p>${"\u{1F600}".repeat(2_000)}</p>`;
  const markdown = renderContent(
    post({ contentHtml: html }),
    names,
    null,
    SITE_HOST,
    500,
  );
  assert.ok(markdown.length <= 500);
  assert.doesNotMatch(markdown, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  assert.doesNotMatch(markdown, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
});

test("password-protected content is never rendered", () => {
  assert.throws(
    () =>
      renderContent(
        post({ protected: true, contentHtml: "" }),
        names,
        null,
        SITE_HOST,
      ),
    (error: unknown) =>
      error instanceof WordPressError && error.code === "BAD_RESPONSE",
  );
});

test("a body past the html-text input ceiling is marked truncated even when it converts short", () => {
  const filler = "<span></span>".repeat(
    Math.ceil(HTML_TO_MARKDOWN_MAX_INPUT_CHARS / 13),
  );
  const over = `${filler.slice(0, HTML_TO_MARKDOWN_MAX_INPUT_CHARS)}<p>tail</p>`;
  assert.ok(over.length > HTML_TO_MARKDOWN_MAX_INPUT_CHARS);
  const markdown = renderContent(
    post({ contentHtml: over }),
    names,
    null,
    SITE_HOST,
  );
  assert.ok(markdown.length < 1_000);
  assert.equal(markdown.split("\n").at(-1), "[Content truncated]");
  assert.equal(markdown.split("[Content truncated]").length, 2);
  assert.equal(markdown.split("\n").at(-2), "");
});

test("a body exactly at the ceiling is not marked truncated", () => {
  const pad = "<span></span>".repeat(1_000);
  const tail = "<p>end</p>";
  const exact =
    pad +
    " ".repeat(HTML_TO_MARKDOWN_MAX_INPUT_CHARS - pad.length - tail.length) +
    tail;
  assert.equal(exact.length, HTML_TO_MARKDOWN_MAX_INPUT_CHARS);
  const markdown = renderContent(
    post({ contentHtml: exact }),
    names,
    null,
    SITE_HOST,
  );
  assert.doesNotMatch(markdown, /Content truncated/);
  assert.ok(markdown.endsWith("end"));
});

test("both limits firing yield exactly one marker", () => {
  const html = `<p>${"word ".repeat(450_000)}</p>`;
  assert.ok(html.length > HTML_TO_MARKDOWN_MAX_INPUT_CHARS);
  const markdown = renderContent(
    post({ contentHtml: html }),
    names,
    null,
    SITE_HOST,
  );
  assert.ok(markdown.length <= MAX_TEXT_CHARS);
  assert.equal(markdown.split("[Content truncated]").length, 2);
  assert.equal(markdown.split("\n").at(-1), "[Content truncated]");
});
