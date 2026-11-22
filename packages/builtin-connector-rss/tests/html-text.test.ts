import assert from "node:assert/strict";
import test from "node:test";
import { htmlToText } from "../src/html-text";

test("paragraphs become blank-line separated text and script content is dropped", () => {
  assert.equal(
    htmlToText("<p>a &amp; b</p><script>alert(1)</script><p>c</p>"),
    "a & b\n\nc",
  );
});

test("style, iframe, svg, noscript, template and head content never appears", () => {
  const text = htmlToText(
    "<html><head><title>TITLE</title><style>.x{}</style></head><body>" +
      "<p>keep</p><iframe>FRAME</iframe><svg><text>SVGTEXT</text></svg>" +
      "<noscript>NOSCRIPT</noscript><template><p>TEMPLATE</p></template>" +
      "</body></html>",
  );
  assert.equal(text, "keep");
});

test("an <img onerror> yields no markup and no attribute text", () => {
  const text = htmlToText("hi <img src=x onerror=alert(1)> there");
  assert.equal(text, "hi there");
  assert.ok(!text.includes("<"));
  assert.ok(!text.includes("onerror"));
});

test("numeric and named entities decode", () => {
  assert.equal(
    htmlToText("<p>it&#39;s&nbsp;fine &lt;ok&gt;</p>"),
    "it's fine <ok>",
  );
});

test("br becomes a newline", () => {
  assert.equal(htmlToText("a<br>b<br/>c"), "a\nb\nc");
});

test("nested lists produce newline-separated lines", () => {
  assert.equal(
    htmlToText(
      "<ul><li>one<ul><li>two</li><li>three</li></ul></li><li>four</li></ul>",
    ),
    "one\ntwo\nthree\nfour",
  );
});

test("three or more blank lines collapse to one blank line", () => {
  assert.equal(htmlToText("<p>a</p><br><br><br><br><p>b</p>"), "a\n\nb");
});

test("non-HTML input passes through trimmed", () => {
  assert.equal(
    htmlToText("  just plain text\nsecond line  "),
    "just plain text\nsecond line",
  );
  assert.equal(htmlToText("   "), "");
});

test("1 MB of nested divs neither throws nor stalls", () => {
  const html = `${"<div>".repeat(200_000)}deep`;
  assert.ok(html.length >= 1_000_000);
  const started = Date.now();
  const text = htmlToText(html);
  assert.equal(typeof text, "string");
  assert.ok(!text.includes("<"));
  assert.ok(Date.now() - started < 5_000, "nesting cap keeps parsing linear");
});

test("realistic nesting depth and unclosed p/li elements keep their text", () => {
  assert.equal(
    htmlToText(`${"<div>".repeat(100)}deep${"</div>".repeat(100)}`),
    "deep",
  );
  const items = Array.from({ length: 800 }, (_, i) => `<li>item ${i}`).join("");
  const text = htmlToText(`<ul>${items}</ul>`);
  assert.ok(text.includes("item 0"));
  assert.ok(text.includes("item 799"));
});
