import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { htmlToMarkdown } from "../src";

const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const timed = <T>(run: () => T): { value: T; ms: number } => {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
};

describe("htmlToMarkdown hostile input", () => {
  it("truncates a 2.5 MB input at the input ceiling within one second", () => {
    const html = "<p>" + "word ".repeat(500_000) + "</p>";
    assert.ok(html.length > 2_400_000);
    const { value, ms } = timed(() =>
      htmlToMarkdown(html, { maxChars: 10_000_000 }),
    );
    assert.ok(ms < 1000, `took ${ms}ms`);
    assert.ok(value.length <= 2_000_000);
    assert.ok(value.length > 1_900_000);
  });

  it("ignores input beyond 2,000,000 characters", () => {
    const html = "a".repeat(2_000_000) + "<p>tail marker</p>";
    const out = htmlToMarkdown(html, { maxChars: 10_000_000 });
    assert.ok(!out.includes("tail marker"));
  });

  it("handles 100,000 unclosed div tags quickly", () => {
    const html = "<div>x".repeat(100_000);
    const { value, ms } = timed(() => htmlToMarkdown(html));
    assert.ok(ms < 1000, `took ${ms}ms`);
    assert.ok(value.length > 0);
  });

  it("handles 100,000 nested ul/li without stack overflow", () => {
    const html = "<ul><li>x".repeat(100_000);
    const { value, ms } = timed(() => htmlToMarkdown(html));
    assert.ok(ms < 1000, `took ${ms}ms`);
    assert.ok(value.includes("- x"));
    const deepest = value
      .split("\n")
      .reduce(
        (max, line) =>
          Math.max(max, (line.match(/^ */) as RegExpMatchArray)[0].length),
        0,
      );
    assert.ok(deepest <= 10);
  });

  it("ignores a tag whose 1 MB attribute is terminated within the input ceiling", () => {
    const html = `<p>before</p><a href="https://x.test/${"a".repeat(1_000_000)}">link</a><p>after</p>`;
    assert.ok(html.length < 2_000_000);
    const { value, ms } = timed(() => htmlToMarkdown(html));
    assert.ok(ms < 1000, `took ${ms}ms`);
    assert.equal(value, "before\n\nlink\n\nafter");
  });

  it("cuts a 10 MB attribute at the input ceiling and keeps the text before it", () => {
    const html = `<p>before</p><a href="https://x.test/${"a".repeat(10_000_000)}">link</a><p>after</p>`;
    const { value, ms } = timed(() => htmlToMarkdown(html));
    assert.ok(ms < 1000, `took ${ms}ms`);
    assert.equal(value, "before");
  });

  it("ignores an attribute value longer than 2,000 characters", () => {
    const long = `https://x.test/${"a".repeat(2_100)}`;
    assert.equal(htmlToMarkdown(`<a href="${long}">t</a>`), "t");
    const ok = `https://x.test/${"a".repeat(100)}`;
    assert.equal(htmlToMarkdown(`<a href="${ok}">t</a>`), `[t](${ok})`);
  });

  it("does not throw on an unclosed a href at the end of input", () => {
    for (const html of [
      '<p>x</p><a href="https://example.com',
      "<p>x</p><a href=",
      "<p>x</p><a",
      "<p>x</p><",
      "<p>x</p><!-- unclosed",
      "<p>x</p><script>unclosed",
    ]) {
      const out = htmlToMarkdown(html);
      assert.ok(out.startsWith("x"), html);
      assert.ok(!out.includes("example.com"), html);
    }
  });

  it("drops a dangling tag at the end and keeps the text before it", () => {
    assert.equal(htmlToMarkdown("<p>keep</p>tail <b"), "keep\n\ntail");
  });

  it("keeps < in text", () => {
    assert.equal(htmlToMarkdown("<p>a < b and c <3 d</p>"), "a < b and c <3 d");
    assert.equal(htmlToMarkdown("1 < 2"), "1 < 2");
  });

  it("never emits a raw <script", () => {
    for (const html of [
      "<script>alert(1)</script>",
      "<scr<script>ipt>alert(1)</scr</script>ipt>",
      "<SCRIPT >x</SCRIPT >",
      "<a href='https://x.test/<script>'>t</a>",
    ]) {
      const out = htmlToMarkdown(html);
      assert.ok(!/<script/i.test(out), `${html} -> ${out}`);
    }
  });

  for (const [tag, marker] of [
    ["b", "**"],
    ["strong", "**"],
    ["em", "*"],
    ["i", "*"],
  ] as const) {
    it(`handles 100,000 repeats of <${tag}><a href> in linear time`, () => {
      // 100,000 pairs exceed the input ceiling, so the text never arrives.
      const flood = `<${tag}><a href="https://x.y">`.repeat(100_000) + "tail";
      const cut = timed(() => htmlToMarkdown(flood));
      assert.ok(cut.ms < 1000, `took ${cut.ms}ms`);
      assert.equal(cut.value, "");

      // Pairs that fit under the ceiling: the text lands in the last link,
      // after every marker that was open before it.
      const unit = `<${tag}><a href="https://x.y">`;
      const pairs = Math.floor(1_900_000 / unit.length);
      const html = unit.repeat(pairs) + "tail";
      assert.ok(html.length < 2_000_000);
      const fit = timed(() => htmlToMarkdown(html));
      assert.ok(fit.ms < 1000, `took ${fit.ms}ms`);
      assert.equal(fit.value, `${marker.repeat(pairs)}[tail](https://x.y)`);
    });
  }

  it("renders 20 nested blockquotes around a body near the input ceiling quickly", () => {
    const open = "<blockquote>".repeat(20);
    const close = "</blockquote>".repeat(20);
    const paragraph = "<p>w</p>";
    const count = Math.floor(
      (2_000_000 - open.length - close.length) / paragraph.length,
    );
    const html = open + paragraph.repeat(count) + close;
    assert.ok(html.length > 1_990_000 && html.length <= 2_000_000);
    const { value, ms } = timed(() => htmlToMarkdown(html));
    assert.ok(ms < 1000, `took ${ms}ms`);
    const line = `${"> ".repeat(20)}w`;
    const blank = "> ".repeat(20).trimEnd();
    assert.ok(value.startsWith(`${line}\n${blank}\n${line}\n`));
    assert.ok(value.length <= 500_000);
    const lines = value.split("\n");
    assert.ok(lines.length > 10_000);
    for (const [index, text] of lines.entries()) {
      assert.equal(text, index % 2 === 0 ? line : blank);
    }
  });

  it("renders every line of a full-size nested blockquote with its prefix", () => {
    const html =
      "<blockquote>".repeat(20) +
      "<p>w</p>".repeat(200_000) +
      "</blockquote>".repeat(20);
    const { value, ms } = timed(() =>
      htmlToMarkdown(html, { maxChars: 50_000_000 }),
    );
    assert.ok(ms < 1000, `took ${ms}ms`);
    const lines = value.split("\n");
    assert.equal(lines.length, 2 * 200_000 - 1);
    assert.equal(lines[0], `${"> ".repeat(20)}w`);
    assert.equal(lines[lines.length - 1], `${"> ".repeat(20)}w`);
  });

  it("handles 100,000 unclosed nested blockquotes quickly", () => {
    const html = "<blockquote>x".repeat(100_000);
    const { value, ms } = timed(() =>
      htmlToMarkdown(html, { maxChars: 50_000_000 }),
    );
    assert.ok(ms < 1000, `took ${ms}ms`);
    assert.ok(value.startsWith("> x\n>\n> > x\n> >\n> > > x"));
    const lines = value.split("\n").filter((l) => l.endsWith("x"));
    assert.equal(lines.length, 100_000);
    assert.equal(lines[lines.length - 1], `${"> ".repeat(20)}x`);
    for (const l of value.split("\n")) assert.match(l, /^(> ?)*x?$/);
  });

  it("does not split a surrogate pair at the input ceiling or the output cut", () => {
    const html = `${"a".repeat(1_999_999)}\u{1f600}tail`;
    const out = htmlToMarkdown(html, { maxChars: 10_000_000 });
    assert.equal(out, "a".repeat(1_999_999));
    assert.ok(!LONE_SURROGATE.test(out));
    const cut = htmlToMarkdown("<p>\u{1f600}\u{1f600}\u{1f600}</p>", {
      maxChars: 3,
    });
    assert.equal(cut, "\u{1f600}");
    assert.ok(!LONE_SURROGATE.test(cut));
  });

  it("rejects a non-positive or NaN maxChars", () => {
    for (const maxChars of [0, -1, Number.NaN]) {
      assert.throws(() => htmlToMarkdown("<p>x</p>", { maxChars }), RangeError);
    }
  });
});
