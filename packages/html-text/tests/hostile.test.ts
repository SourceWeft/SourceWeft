import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { htmlToMarkdown } from "../src";

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

  it("ignores a tag with a 10 MB attribute", () => {
    const html = `<p>before</p><a href="https://x.test/${"a".repeat(10_000_000)}">link</a><p>after</p>`;
    const { value, ms } = timed(() => htmlToMarkdown(html));
    assert.ok(ms < 1000, `took ${ms}ms`);
    assert.ok(!value.includes("aaaa"));
    assert.ok(!value.includes("x.test"));
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

  it("treats an unclosed tag at the end as text up to that point", () => {
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
});
