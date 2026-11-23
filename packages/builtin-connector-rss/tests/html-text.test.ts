import assert from "node:assert/strict";
import test from "node:test";
import { htmlToText } from "../src/html-text";

// Upper bound for the hostile-shape timing tests. A quadratic shape at these
// sizes takes 3 s to minutes; typical linear runs take 1 ms to about 110 ms
// (the ~5 MiB mix about 105 ms, the 4 MiB 600k-attribute tag about 55 ms,
// 3,000 heavy tags about 210 ms) on an idle machine. 6 s keeps the guard
// meaningful while tolerating a heavily loaded CI or developer machine.
const HOSTILE_TIME_BOUND_MS = 6_000;

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
    assert.ok(
      Date.now() - started < HOSTILE_TIME_BOUND_MS,
      `took ${Date.now() - started} ms`,
    );
  });
}

test("a ~5 MiB mix of hostile shapes neither throws nor stalls", () => {
  const html = Object.values(HOSTILE_SHAPES)
    .map((unit) => unit.repeat(200_000))
    .join("")
    .slice(0, 5 * 1024 * 1024);
  const started = Date.now();
  htmlToText(html);
  assert.ok(
    Date.now() - started < HOSTILE_TIME_BOUND_MS,
    `took ${Date.now() - started} ms`,
  );
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

const uniqueAttrs = (count: number): string =>
  Array.from({ length: count }, (_, i) => `a${i}=1`).join(" ");

test("a tag with 60k unique attributes neither throws nor stalls, and earlier content survives", () => {
  const html = `<p>before</p><a ${uniqueAttrs(60_000)}>after`;
  assert.ok(html.length >= 400_000);
  const started = Date.now();
  const text = htmlToText(html);
  assert.equal(text, "before");
  assert.ok(
    Date.now() - started < HOSTILE_TIME_BOUND_MS,
    `took ${Date.now() - started} ms`,
  );
});

test("a ~4 MiB tag with 600k attributes neither throws nor stalls", () => {
  const html = `<a ${uniqueAttrs(600_000)}>x`;
  assert.ok(html.length >= 4 * 1024 * 1024);
  const started = Date.now();
  assert.equal(htmlToText(html), "");
  assert.ok(
    Date.now() - started < HOSTILE_TIME_BOUND_MS,
    `took ${Date.now() - started} ms`,
  );
});

test("an unterminated tag with endless attributes neither throws nor stalls", () => {
  const html = `<p>kept</p><a${" x".repeat(2_000_000)}`;
  const started = Date.now();
  assert.equal(htmlToText(html), "kept");
  assert.ok(
    Date.now() - started < HOSTILE_TIME_BOUND_MS,
    `took ${Date.now() - started} ms`,
  );
});

test("an oversized end tag is cut the same way", () => {
  const html = `<p>kept</p></a ${uniqueAttrs(60_000)}>tail`;
  assert.equal(htmlToText(html), "kept");
});

test("an ordinary tag with ~20 attributes and a long href is unchanged", () => {
  const href = `https://example.com/${"path/".repeat(800)}?q=${"v".repeat(500)}`;
  assert.ok(href.length > 4_000);
  const attrs = Array.from({ length: 20 }, (_, i) => `data-k${i}="v${i}"`).join(
    " ",
  );
  const html = `<p>intro</p><a href="${href}" ${attrs}>link text</a><p>outro</p>`;
  assert.equal(htmlToText(html), "intro\n\nlink text\n\noutro");
});

const withinTimeBound = (html: string): string => {
  const started = Date.now();
  const text = htmlToText(html);
  assert.ok(
    Date.now() - started < HOSTILE_TIME_BOUND_MS,
    `took ${Date.now() - started} ms`,
  );
  return text;
};

test("many-attribute tags cannot hide behind a quoted > or adjacent quotes", () => {
  const quoted = `<p>kept</p><a x=">" ${uniqueAttrs(60_000)}>tail`;
  assert.equal(withinTimeBound(quoted), "kept");
  const adjacent = Array.from({ length: 60_000 }, (_, i) => `a${i}="1"`).join(
    "",
  );
  assert.equal(withinTimeBound(`<p>kept</p><a ${adjacent}>tail`), "kept");
  const slashes = Array.from({ length: 60_000 }, (_, i) => `a${i}`).join("/");
  assert.equal(withinTimeBound(`<p>kept</p><a ${slashes}>tail`), "kept");
  const spaced = Array.from({ length: 60_000 }, (_, i) => `a${i} = "1"`).join(
    " ",
  );
  assert.equal(withinTimeBound(`<p>kept</p><a ${spaced}>tail`), "kept");
});

test("a many-attribute tag cannot hide after a comment or script that mentions quotes", () => {
  const heavy = `<b ${uniqueAttrs(60_000)}>`;
  const afterComment = `<p>kept</p><!-- <a x=" --> ${heavy} <i y="-->`;
  assert.equal(withinTimeBound(afterComment), "kept");
  const afterScript = `<p>kept</p><script>var s = "<a x='";</script> ${heavy} <i y='</script>`;
  assert.equal(withinTimeBound(afterScript), "kept");
});

test("thousands of heavy tags (just under the attribute cap) stay fast", () => {
  const tag = `<a ${uniqueAttrs(120)}>x</a>`;
  const html = tag.repeat(Math.floor((5 * 1024 * 1024) / tag.length));
  assert.ok(html.length > 4 * 1024 * 1024);
  withinTimeBound(html);
});

test("tags with quoted > in values, comments and script text parse as before", () => {
  assert.equal(
    htmlToText(
      '<p title="a > b">one</p><!-- <b> --><script>if (a < b) {}</script><p>two</p>',
    ),
    "one\n\ntwo",
  );
  assert.equal(htmlToText("<p>a < b and c > d</p>"), "a < b and c > d");
});
