import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { htmlToMarkdown } from "../src";

describe("htmlToMarkdown", () => {
  it("renders headings and paragraphs", () => {
    const html =
      "<h1>Title</h1><p>First para.</p><h2>Sub</h2><p>Second <strong>bold</strong> and <em>it</em>.</p><h6>Deep</h6>";
    assert.equal(
      htmlToMarkdown(html),
      "# Title\n\nFirst para.\n\n## Sub\n\nSecond **bold** and *it*.\n\n###### Deep",
    );
  });

  it("maps b and i like strong and em, and br to a newline", () => {
    assert.equal(
      htmlToMarkdown("<p><b>x</b> <i>y</i><br>z</p>"),
      "**x** *y*\nz",
    );
  });

  it("separates div, section, article and figure with blank lines", () => {
    assert.equal(
      htmlToMarkdown(
        "<div>a</div><section>b</section><article>c</article><figure>d</figure>",
      ),
      "a\n\nb\n\nc\n\nd",
    );
  });

  it("renders figcaption as its own paragraph", () => {
    assert.equal(
      htmlToMarkdown(
        '<figure><img src="https://x.test/a.png" alt="A chart"><figcaption>Figure 1</figcaption></figure>',
      ),
      "A chart\n\nFigure 1",
    );
  });

  it("keeps nested list order and caps indentation", () => {
    assert.equal(
      htmlToMarkdown(
        "<ul><li>one<ul><li>two<ul><li>three</li></ul></li></ul></li><li>four</li></ul>",
      ),
      "- one\n  - two\n    - three\n- four",
    );
    assert.equal(htmlToMarkdown("<ol><li>a</li><li>b</li></ol>"), "1. a\n2. b");
    assert.equal(
      htmlToMarkdown("<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>"),
      "1. a\n   - b\n2. c",
    );
    let html = "";
    for (let k = 0; k < 12; k += 1) html += `<ul><li>L${k}`;
    for (let k = 0; k < 12; k += 1) html += "</li></ul>";
    const lines = htmlToMarkdown(html).split("\n");
    assert.equal(lines.length, 12);
    const indents = lines.map(
      (line) => (line.match(/^ */) as RegExpMatchArray)[0].length,
    );
    assert.ok(Math.max(...indents) <= 10, `max indent ${Math.max(...indents)}`);
    assert.equal(indents[11], indents[5]);
    assert.ok((indents[5] as number) > (indents[4] as number));
    assert.ok(lines[11]?.endsWith("L11"));
  });

  it("caps blockquote depth", () => {
    assert.equal(
      htmlToMarkdown(
        "<blockquote><p>a</p><blockquote>b</blockquote></blockquote>",
      ),
      "> a\n>\n> > b",
    );
    const depth = 50;
    const html =
      "<blockquote>".repeat(depth) + "deep" + "</blockquote>".repeat(depth);
    const out = htmlToMarkdown(html);
    const prefix = (out.match(/^(> )*/) as RegExpMatchArray)[0];
    assert.equal(prefix.length / 2, 20);
    assert.ok(out.endsWith("deep"));
  });

  it("keeps pre/code text verbatim including < and *", () => {
    const out = htmlToMarkdown(
      "<pre><code>if (a &lt; b) { *x* &amp;&amp; &lt;script&gt; }\n  indented</code></pre>",
    );
    assert.equal(out, "```\nif (a < b) { *x* && <script> }\n  indented\n```");
    assert.equal(
      htmlToMarkdown("<p>use <code>a&lt;b</code> here</p>"),
      "use `a<b` here",
    );
    assert.equal(
      htmlToMarkdown("<pre><code>```\nx\n```</code></pre>"),
      "````\n```\nx\n```\n````",
    );
  });

  it("keeps links only for http and https hrefs", () => {
    assert.equal(
      htmlToMarkdown('<a href="https://example.com/a?b=1">site</a>'),
      "[site](https://example.com/a?b=1)",
    );
    assert.equal(
      htmlToMarkdown("<a href='http://example.com'>plain</a>"),
      "[plain](http://example.com)",
    );
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "/relative/path",
      "relative.html",
      "//example.com/x",
      "https://exa\tmple.com",
      "https://example.com/\u0001x",
      "  javascript:alert(1)",
      "vbscript:x",
    ]) {
      assert.equal(
        htmlToMarkdown(`<a href="${href}">text</a>`),
        "text",
        `href ${JSON.stringify(href)}`,
      );
    }
    assert.equal(htmlToMarkdown("<a>no href</a>"), "no href");
  });

  it("renders an image as alt text only and never the src", () => {
    assert.equal(
      htmlToMarkdown(
        '<p>x <img src="https://evil.test/p.png" alt="A cat"> y</p>',
      ),
      "x A cat y",
    );
    const none = htmlToMarkdown('<img src="https://evil.test/p.png" alt="">');
    assert.equal(none, "");
    const missing = htmlToMarkdown(
      '<p>a<img src="https://evil.test/q.png">b</p>',
    );
    assert.equal(missing, "ab");
    assert.ok(!missing.includes("evil.test"));
  });

  it("renders tables as pipe rows", () => {
    assert.equal(
      htmlToMarkdown(
        "<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>Apple</td><td>  3\n </td></tr><tr><td>Pear <b>x</b></td><td>4</td></tr></tbody></table>",
      ),
      "| Name | Qty |\n| Apple | 3 |\n| Pear **x** | 4 |",
    );
  });

  it("renders hr as a rule", () => {
    assert.equal(htmlToMarkdown("<p>a</p><hr><p>b</p>"), "a\n\n---\n\nb");
  });

  it("decodes entities one level and leaves unknown ones", () => {
    assert.equal(htmlToMarkdown("<p>&amp;lt; &amp;amp;</p>"), "&lt; &amp;");
    assert.equal(
      htmlToMarkdown("<p>&lt;b&gt; &quot;q&quot; &apos;s&apos;&nbsp;z</p>"),
      "<b> \"q\" 's' z",
    );
    assert.equal(htmlToMarkdown("<p>it&#8217;s &#x2019; ok</p>"), "it’s ’ ok");
    assert.equal(
      htmlToMarkdown("<p>&unknown; &#xZZ; &#0;</p>"),
      "&unknown; &#xZZ; &#0;",
    );
  });

  it("drops Gutenberg comments, script, style, svg and friends with content", () => {
    const html =
      '<!-- wp:paragraph --><p>Keep</p><!-- /wp:paragraph --><script>alert("x")</script><style>p{color:red}</style><svg><title>t</title><path d="M0"/></svg>' +
      "<iframe src=x>inner</iframe><form><input>formtext</form><noscript>ns</noscript><template><p>tpl</p></template>" +
      "<!DOCTYPE html><![CDATA[cd]]><p>End</p>";
    assert.equal(htmlToMarkdown(html), "Keep\n\nEnd");
  });

  it("collapses whitespace", () => {
    assert.equal(
      htmlToMarkdown("<p>  a \n\t b   c </p>\n\n\n\n<p>d</p>\n\n\n<p>\n</p>"),
      "a b c\n\nd",
    );
  });

  it("cuts at maxChars on a line boundary", () => {
    const html = "<p>aaaa</p><p>bbbb</p><p>cccc</p>";
    assert.equal(htmlToMarkdown(html, { maxChars: 12 }), "aaaa\n\nbbbb");
    assert.equal(htmlToMarkdown(html, { maxChars: 9 }), "aaaa");
    assert.equal(htmlToMarkdown(html, { maxChars: 3 }), "aaa");
    assert.equal(
      htmlToMarkdown(html, { maxChars: 1000 }),
      "aaaa\n\nbbbb\n\ncccc",
    );
    const lines = Array.from(
      { length: 100 },
      (_, k) => `<p>line ${k}</p>`,
    ).join("");
    const cut = htmlToMarkdown(lines, { maxChars: 100 });
    assert.ok(cut.length <= 100);
    assert.match(cut, /line \d+$/);
    assert.equal(cut, cut.trimEnd());
  });
});
