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

// Hostile shapes that keep parse5's open-element stack growing (it rescans the
// stack per tag, so they are quadratic without a cap). Each must finish fast.
const HOSTILE_SHAPES: Record<string, string> = {
  "nested divs": "<div>",
  "self-closing divs": "<div/>",
  "divs with stray end tags": "<div></span>",
  "unterminated tags": "<a",
  "foster-parented table content": "<div><table></div>",
  "nested templates": "<template>",
  "misnested formatting": "<b><i></b></i>",
  "unclosed table cells": "<div><td></div>",
};

for (const [name, unit] of Object.entries(HOSTILE_SHAPES)) {
  test(`hostile input (${name}, 200k repeats) neither throws nor stalls`, () => {
    const html = `${unit.repeat(200_000)}tail`;
    assert.ok(html.length >= 400_000);
    const started = Date.now();
    const text = htmlToText(html);
    assert.equal(typeof text, "string");
    assert.ok(!text.includes("<div"));
    assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
  });
}

test("a ~5 MiB mix of hostile shapes neither throws nor stalls", () => {
  const html = Object.values(HOSTILE_SHAPES)
    .map((unit) => unit.repeat(200_000))
    .join("")
    .slice(0, 5 * 1024 * 1024);
  const started = Date.now();
  htmlToText(html);
  assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
});

test("realistic nesting depth and unclosed p/li/td elements keep their text", () => {
  assert.equal(
    htmlToText(`${"<div>".repeat(100)}deep${"</div>".repeat(100)}`),
    "deep",
  );
  const items = Array.from({ length: 800 }, (_, i) => `<li>item ${i}`).join("");
  const list = htmlToText(`<ul>${items}</ul>`);
  assert.ok(list.includes("item 0"));
  assert.ok(list.includes("item 799"));
  const paragraphs = Array.from({ length: 800 }, (_, i) => `<p>para ${i}`).join(
    "",
  );
  assert.ok(htmlToText(paragraphs).includes("para 799"));
  const cells = Array.from({ length: 800 }, (_, i) => `<td>cell ${i}`).join("");
  assert.ok(htmlToText(`<table><tr>${cells}</table>`).includes("cell 799"));
});

test("pretty-printed markup does not add blank lines between blocks", () => {
  assert.equal(htmlToText("<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>"), "a\nb");
  assert.equal(htmlToText("<div>a</div>\n<div>b</div>"), "a\nb");
  assert.equal(htmlToText("<p>a</p>\n\n<p>b</p>\n"), "a\n\nb");
  assert.equal(htmlToText("<p>one <b>two</b> three</p>"), "one two three");
});
