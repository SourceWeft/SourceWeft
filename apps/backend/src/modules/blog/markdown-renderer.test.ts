import assert from "node:assert/strict";
import { test } from "vitest";
import {
  renderMarkdownContent,
  UnsupportedMarkdownError,
} from "./markdown-renderer";

const html = (markdown: string) => renderMarkdownContent(markdown).contentHtml;

test("headings get ids; # and ## are h2, deeper levels are h3", () => {
  assert.equal(
    html("# What is MCP?\n\n## The short answer\n\n### PostgreSQL\n\n#### Deeper"),
    [
      '<h2 id="what-is-mcp">What is MCP?</h2>',
      '<h2 id="the-short-answer">The short answer</h2>',
      '<h3 id="postgresql">PostgreSQL</h3>',
      '<h3 id="deeper">Deeper</h3>',
    ].join("\n"),
  );
  assert.equal(html("## 先说结论"), '<h2 id="先说结论">先说结论</h2>');
});

test("inline formatting, code spans and escaping", () => {
  assert.equal(
    html("A **bold** *em* ~~gone~~ `npx <slug>` & \"quoted\" it's"),
    "<p>A <strong>bold</strong> <em>em</em> <s>gone</s> <code>npx &lt;slug&gt;</code> &amp; &quot;quoted&quot; it&#39;s</p>",
  );
});

test("raw HTML is shown as text, and comments are dropped", () => {
  assert.equal(
    html("Hello <script>alert(1)</script> there"),
    "<p>Hello &lt;script&gt;alert(1)&lt;/script&gt; there</p>",
  );
  assert.equal(html("<div onclick=\"x()\">block</div>"), "<p>&lt;div onclick=&quot;x()&quot;&gt;block&lt;/div&gt;</p>");
  assert.equal(html("<!-- editor note -->\n\nBody"), "<p>Body</p>");
});

test("links: site links stay followable, others carry nofollow", () => {
  assert.equal(
    html("[directory](https://sourceweft.com/mcp) and [spec](https://modelcontextprotocol.io/?a=1&b=2)"),
    '<p><a href="https://sourceweft.com/mcp">directory</a> and <a href="https://modelcontextprotocol.io/?a=1&amp;b=2" rel="nofollow noopener noreferrer">spec</a></p>',
  );
});

test("relative and non-http links are rejected", () => {
  assert.throws(() => html("[x](/blog/y)"), UnsupportedMarkdownError);
  assert.throws(() => html("[x](javascript:alert(1))"), UnsupportedMarkdownError);
});

test("lists, nested lists, ordered lists and task items", () => {
  assert.equal(
    html("- one\n  - nested\n- two\n\n1. first\n2. second\n\n- [x] done\n- [ ] todo"),
    [
      "<ul><li>one\n<ul><li>nested</li></ul></li><li>two</li></ul>",
      "<ol><li>first</li><li>second</li></ol>",
      '<ul><li><input type="checkbox" disabled checked> done</li><li><input type="checkbox" disabled> todo</li></ul>',
    ].join("\n"),
  );
});

test("a list item that starts with bold keeps its inline content", () => {
  assert.equal(
    html("1. **Who publishes it.** Prefer the vendor."),
    "<ol><li><strong>Who publishes it.</strong> Prefer the vendor.</li></ol>",
  );
});

test("tables render like the Notion renderer's, inside .blog-table", () => {
  const out = renderMarkdownContent(
    "| Server | Runs |\n|---|---|\n| [Neon](https://sourceweft.com/mcp/com.neon%2Fmcp) | `Remote` |",
  );
  assert.equal(
    out.contentHtml,
    '<div class="blog-table"><table><thead><tr><th scope="col">Server</th><th scope="col">Runs</th></tr></thead><tbody><tr><td><a href="https://sourceweft.com/mcp/com.neon%2Fmcp">Neon</a></td><td><code>Remote</code></td></tr></tbody></table></div>',
  );
  assert.equal(out.contentText, "Server | Runs\nNeon | Remote");
});

test("code blocks keep their text and language", () => {
  assert.equal(
    html("```sh\nnpx @sourceweft/cli skills install <slug>\n```"),
    '<pre><code class="language-sh">npx @sourceweft/cli skills install &lt;slug&gt;</code></pre>',
  );
});

test("quotes and rules", () => {
  assert.equal(html("> quoted **text**\n\n---"), "<blockquote><p>quoted <strong>text</strong></p></blockquote>\n<hr>");
});

test("images are refused for now", () => {
  assert.throws(
    () => html("![alt](https://sourceweft.com/x.png)"),
    /Images are not supported/,
  );
});

test("plain text, hash and reading time come from the rendered content", () => {
  const first = renderMarkdownContent("## Title\n\nSome **words** here.");
  const again = renderMarkdownContent("## Title\n\nSome **words** here.");
  const other = renderMarkdownContent("## Title\n\nOther words.");
  assert.equal(first.contentText, "Title\n\nSome words here.");
  assert.equal(first.contentHash, again.contentHash);
  assert.notEqual(first.contentHash, other.contentHash);
  assert.equal(first.readingTimeMinutes, 1);
  assert.deepEqual(first.assetIds, []);
});
