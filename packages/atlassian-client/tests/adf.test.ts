import assert from "node:assert/strict";
import test from "node:test";
import { adfToMarkdown } from "../src/adf";

function text(value: string, marks?: Record<string, unknown>[]) {
  return marks ? { type: "text", text: value, marks } : { type: "text", text: value };
}

function paragraph(...content: unknown[]) {
  return { type: "paragraph", content };
}

function doc(...content: unknown[]) {
  return { type: "doc", version: 1, content };
}

test("paragraph: inline content, then a blank line between blocks", () => {
  const input = doc(paragraph(text("First paragraph")), paragraph(text("Second paragraph")));
  assert.equal(adfToMarkdown(input), "First paragraph\n\nSecond paragraph");
});

test("heading: #-count + space + text, for levels 1-6", () => {
  for (let level = 1; level <= 6; level++) {
    const input = doc({ type: "heading", attrs: { level }, content: [text(`Heading ${level}`)] });
    assert.equal(adfToMarkdown(input), `${"#".repeat(level)} Heading ${level}`);
  }
});

test("bulletList / listItem: '- ' items", () => {
  const input = doc({
    type: "bulletList",
    content: [
      { type: "listItem", content: [paragraph(text("First"))] },
      { type: "listItem", content: [paragraph(text("Second"))] },
    ],
  });
  assert.equal(adfToMarkdown(input), "- First\n- Second");
});

test("orderedList / listItem: '1. ' items", () => {
  const input = doc({
    type: "orderedList",
    content: [
      { type: "listItem", content: [paragraph(text("First"))] },
      { type: "listItem", content: [paragraph(text("Second"))] },
    ],
  });
  assert.equal(adfToMarkdown(input), "1. First\n2. Second");
});

test("nested lists indent two spaces per level", () => {
  const input = doc({
    type: "bulletList",
    content: [
      {
        type: "listItem",
        content: [
          paragraph(text("Item 1")),
          {
            type: "bulletList",
            content: [{ type: "listItem", content: [paragraph(text("Nested"))] }],
          },
        ],
      },
    ],
  });
  assert.equal(adfToMarkdown(input), "- Item 1\n  - Nested");
});

test("codeBlock: fenced block with attrs.language as the info string", () => {
  const input = doc({
    type: "codeBlock",
    attrs: { language: "ts" },
    content: [text("const x = 1;")],
  });
  assert.equal(adfToMarkdown(input), "```ts\nconst x = 1;\n```");
});

test("codeBlock without a language: empty info string", () => {
  const input = doc({ type: "codeBlock", content: [text("plain")] });
  assert.equal(adfToMarkdown(input), "```\nplain\n```");
});

test("blockquote: each line prefixed '> '", () => {
  const input = doc({ type: "blockquote", content: [paragraph(text("Quoted text."))] });
  assert.equal(adfToMarkdown(input), "> Quoted text.");
});

test("table: pipe table with a '---' separator after the first row", () => {
  function cell(type: string, value: string) {
    return { type, content: [paragraph(text(value))] };
  }
  const input = doc({
    type: "table",
    content: [
      { type: "tableRow", content: [cell("tableHeader", "A"), cell("tableHeader", "B")] },
      { type: "tableRow", content: [cell("tableCell", "1"), cell("tableCell", "2")] },
    ],
  });
  assert.equal(adfToMarkdown(input), "| A | B |\n| --- | --- |\n| 1 | 2 |");
});

test("table with a pipe in a cell: escaped, and cell newlines become spaces", () => {
  function cell(value: unknown[]) {
    return { type: "tableCell", content: value };
  }
  const input = doc({
    type: "table",
    content: [
      {
        type: "tableRow",
        content: [
          cell([paragraph(text("a|b"))]),
          cell([paragraph(text("Line1"), { type: "hardBreak" }, text("Line2"))]),
        ],
      },
    ],
  });
  assert.equal(adfToMarkdown(input), "| a\\|b | Line1 Line2 |\n| --- | --- |");
});

test("rule: '---'", () => {
  const input = doc(paragraph(text("Before")), { type: "rule" }, paragraph(text("After")));
  assert.equal(adfToMarkdown(input), "Before\n\n---\n\nAfter");
});

test("hardBreak: newline", () => {
  const input = doc(paragraph(text("Line1"), { type: "hardBreak" }, text("Line2")));
  assert.equal(adfToMarkdown(input), "Line1\nLine2");
});

test("text marks: strong, em, code, strike", () => {
  assert.equal(
    adfToMarkdown(doc(paragraph(text("bold", [{ type: "strong" }])))),
    "**bold**",
  );
  assert.equal(adfToMarkdown(doc(paragraph(text("italic", [{ type: "em" }])))), "*italic*");
  assert.equal(adfToMarkdown(doc(paragraph(text("code", [{ type: "code" }])))), "`code`");
  assert.equal(
    adfToMarkdown(doc(paragraph(text("gone", [{ type: "strike" }])))),
    "~~gone~~",
  );
});

test("text marks: link renders as [text](href) for http(s) hrefs", () => {
  const input = doc(
    paragraph(text("site", [{ type: "link", attrs: { href: "https://example.com" } }])),
  );
  assert.equal(adfToMarkdown(input), "[site](https://example.com)");
});

test("javascript: link renders as text", () => {
  const input = doc(
    paragraph(text("click me", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])),
  );
  assert.equal(adfToMarkdown(input), "click me");
});

test("text marks: combined marks nest in array order (strong then em -> ***x***)", () => {
  const input = doc(
    paragraph(text("both", [{ type: "strong" }, { type: "em" }])),
  );
  assert.equal(adfToMarkdown(input), "***both***");
});

test("mention: attrs.text, or '@' + attrs.id when text is absent", () => {
  assert.equal(
    adfToMarkdown(doc(paragraph({ type: "mention", attrs: { id: "123", text: "@Jane" } }))),
    "@Jane",
  );
  assert.equal(
    adfToMarkdown(doc(paragraph({ type: "mention", attrs: { id: "123" } }))),
    "@123",
  );
});

test("emoji: attrs.text, or attrs.shortName when text is absent", () => {
  assert.equal(
    adfToMarkdown(doc(paragraph({ type: "emoji", attrs: { shortName: ":smile:", text: "\u{1F600}" } }))),
    "\u{1F600}",
  );
  assert.equal(
    adfToMarkdown(doc(paragraph({ type: "emoji", attrs: { shortName: ":smile:" } }))),
    ":smile:",
  );
});

test("inlineCard / blockCard: attrs.url", () => {
  assert.equal(
    adfToMarkdown(doc(paragraph({ type: "inlineCard", attrs: { url: "https://example.com/x" } }))),
    "https://example.com/x",
  );
  assert.equal(
    adfToMarkdown(doc({ type: "blockCard", attrs: { url: "https://example.com/y" } })),
    "https://example.com/y",
  );
});

test("mediaSingle / media / mediaGroup: render nothing", () => {
  const input = doc(
    paragraph(text("Before")),
    { type: "mediaSingle", content: [{ type: "media", attrs: { id: "1" } }] },
    { type: "mediaGroup", content: [{ type: "media", attrs: { id: "2" } }] },
    paragraph(text("After")),
  );
  assert.equal(adfToMarkdown(input), "Before\n\nAfter");
});

test("unknown node type: concatenated text of its descendants", () => {
  const input = doc({
    type: "weirdNode",
    content: [{ type: "alsoWeird", content: [text("Hello ")] }, text("World")],
  });
  assert.equal(adfToMarkdown(input), "Hello World");
});

test("adf is total: never throws, always returns a string", () => {
  const inputs: unknown[] = [
    null,
    "text",
    {},
    { type: "doc" },
    doc({ type: "paragraph", content: "x" }),
    doc({ type: "unknownWrapper", content: [text("ok")] }),
  ];
  for (const input of inputs) {
    assert.doesNotThrow(() => adfToMarkdown(input));
    assert.equal(typeof adfToMarkdown(input), "string");
  }
});

test("adf is total: a 200-deep chain of blockquote returns a string without throwing", () => {
  let node: unknown = paragraph(text("deep"));
  for (let i = 0; i < 200; i++) {
    node = { type: "blockquote", content: [node] };
  }
  const input = doc(node);
  assert.doesNotThrow(() => adfToMarkdown(input));
  assert.equal(typeof adfToMarkdown(input), "string");
});

test("recursion depth capped at 50: deeper content renders as concatenated text", () => {
  // 60 nested blockquotes wrapping a paragraph; only the outer 50 levels are
  // rendered as '> ' prefixed blockquotes (one per level), the rest collapse
  // to plain concatenated text instead of contributing 10 more '> ' prefixes.
  let node: unknown = paragraph(text("deep text"));
  for (let i = 0; i < 60; i++) {
    node = { type: "blockquote", content: [node] };
  }
  const input = doc(node);
  const result = adfToMarkdown(input);
  assert.ok(result.endsWith("deep text"));
  const leadingQuoteMarkers = result.match(/^(> )+/)?.[0] ?? "";
  assert.equal(leadingQuoteMarkers.length / "> ".length, 50);
});

test("output is trimmed and has at most one blank line between blocks", () => {
  const input = doc(
    paragraph(text("A")),
    { type: "unknownBlock" },
    { type: "unknownBlock" },
    paragraph(text("B")),
  );
  assert.equal(adfToMarkdown(input), "A\n\nB");
});
