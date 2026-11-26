import assert from "node:assert/strict";
import test from "node:test";
import { noteHtmlToText } from "../src/note-text";

test("paragraphs and headings become separate lines", () => {
  assert.equal(
    noteHtmlToText("<h1>Title</h1><p>First</p><p>Second</p>"),
    "Title\n\nFirst\n\nSecond",
  );
});

test("br is a single line break", () => {
  assert.equal(noteHtmlToText("a<br>b<br/>c<br />d"), "a\nb\nc\nd");
});

test("list items get a dash and their own line", () => {
  assert.equal(
    noteHtmlToText("<ul><li>one</li><li>two</li></ul><ol><li>three</li></ol>"),
    "- one\n- two\n- three",
  );
});

test("nested inline tags are dropped and text kept", () => {
  assert.equal(
    noteHtmlToText(
      '<p>a <strong>b <em>c</em></strong> <a href="https://x.test">d</a></p>',
    ),
    "a b c d",
  );
});

test("named entities are decoded exactly once", () => {
  assert.equal(
    noteHtmlToText("<p>a &amp; b &lt;i&gt; &quot;q&quot; it&#39;s&nbsp;ok</p>"),
    `a & b <i> "q" it's ok`,
  );
  assert.equal(noteHtmlToText("&amp;lt;"), "&lt;");
});

test("numeric entities decode, invalid ones stay as written", () => {
  assert.equal(noteHtmlToText("&#65;&#x42;&#X43;"), "ABC");
  assert.equal(
    noteHtmlToText("&#0; &#1114112; &#xD800; &bogus;"),
    "&#0; &#1114112; &#xD800; &bogus;",
  );
});

test("encoded markup is text, not a tag", () => {
  assert.equal(
    noteHtmlToText("&lt;script&gt;alert(1)&lt;/script&gt;"),
    "<script>alert(1)</script>",
  );
});

test("script and style content is removed", () => {
  assert.equal(
    noteHtmlToText(
      "<p>a</p><script>var x = '<p>evil</p>';</script><style>p{color:red}</style><p>b</p>",
    ),
    "a\n\nb",
  );
  assert.equal(noteHtmlToText("x<SCRIPT >evil</SCRIPT >y"), "xy");
  assert.equal(noteHtmlToText("x<script>never closed"), "x");
});

test("comments are dropped", () => {
  assert.equal(noteHtmlToText("a<!-- hidden <p>x</p> -->b"), "ab");
  assert.equal(noteHtmlToText("a<!-- unterminated"), "a");
});

test("whitespace is collapsed", () => {
  assert.equal(
    noteHtmlToText("<p>  a \n\t b  </p>\n\n\n<p> c </p>"),
    "a b\n\nc",
  );
});

test("input is capped at 1,000,000 characters", () => {
  const out = noteHtmlToText(`<p>${"a".repeat(1_500_000)}</p>`);
  assert.ok(out.length <= 1_000_000);
  assert.ok(out.length > 900_000);
});

test("malformed and hostile HTML does not throw and stays fast", () => {
  const inputs = [
    "<",
    "<<<<<<",
    "<p",
    "<p <b>>text",
    "a < b > c",
    "</>",
    "<>x</>",
    "<p>unclosed <b>bold",
    "<".repeat(900_000),
    `${"< ".repeat(400_000)}>`,
    "<a".repeat(400_000),
    "<script".repeat(100_000),
    "&".repeat(500_000),
    "<li>".repeat(100_000),
  ];
  const started = Date.now();
  for (const input of inputs) {
    assert.equal(typeof noteHtmlToText(input), "string");
  }
  assert.ok(Date.now() - started < 5_000);
});

test("a stray less-than sign stays as text", () => {
  assert.equal(noteHtmlToText("1 < 2 and 3 > 2"), "1 < 2 and 3 > 2");
});

test("non-string input yields empty text", () => {
  assert.equal(noteHtmlToText(undefined as unknown as string), "");
});

test("a stray less-than sign before a real tag does not swallow it", () => {
  assert.equal(noteHtmlToText("a < <b>bold</b> <p>x</p>"), "a < bold\n\nx");
});
