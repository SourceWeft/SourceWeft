import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SkillMarkdown } from "./skill-markdown";

function render(markdown: string) {
  return renderToStaticMarkup(
    <SkillMarkdown imagePlaceholder="Image">{markdown}</SkillMarkdown>,
  );
}

describe("SkillMarkdown", () => {
  it("renders ordinary markdown", () => {
    const html = render("# Title\n\nSome **bold** text.\n\n- one\n- two");
    expect(html).toContain("Title");
    expect(html).toMatch(/<(strong|span)[^>]*>bold</);
    expect(html).toContain("<li");
  });

  it("keeps the page's <h1> the only one: the document's headings sit a level down", () => {
    const html = render("# Title\n\n## Section\n\n###### Deep");
    expect(html).not.toContain("<h1");
    expect(html).toMatch(/<h2[^>]*>Title<\/h2>/);
    expect(html).toMatch(/<h3[^>]*>Section<\/h3>/);
    // Nothing below <h6> exists, so the deepest level becomes a paragraph.
    expect(html).toMatch(/<p[^>]*>Deep<\/p>/);
  });

  it("never turns embedded HTML into markup", () => {
    const html = render(
      [
        "Before",
        "",
        '<script>alert("x")</script>',
        "",
        '<img src="https://evil.example/pixel.png" onerror="alert(1)">',
        "",
        '<iframe src="https://evil.example"></iframe>',
        "",
        'Inline <b onclick="alert(1)">bold</b> and <example>kept as text</example>.',
      ].join("\n"),
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<b[ >]/i);
    // The only real elements are the ones markdown itself produced.
    const tags = new Set(
      [...html.matchAll(/<([a-z][a-z0-9]*)/gi)].map((match) => match[1]),
    );
    expect([...tags].sort()).toEqual(["div", "p"]);
    // The author's text survives, escaped.
    expect(html).toContain("&lt;b onclick=");
    expect(html).toContain("&lt;example&gt;");
    expect(html).toContain("kept as text");
  });

  it("marks every external link nofollow ugc and opens it in a new tab", () => {
    const html = render(
      "See [the docs](https://example.com/docs) or <https://example.org>.",
    );
    const anchors = html.match(/<a [^>]*>/g) ?? [];
    expect(anchors.length).toBe(2);
    for (const anchor of anchors) {
      expect(anchor).toContain('rel="nofollow ugc noopener noreferrer"');
      expect(anchor).toContain('target="_blank"');
    }
  });

  it("does not link javascript: or repository-relative targets", () => {
    const html = render(
      "[run](javascript:alert(1)) and [reference](references/guide.md)",
    );
    expect(html).not.toMatch(/<a /);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("run");
    expect(html).toContain("reference");
  });

  it("does not load remote images", () => {
    const html = render("![Diagram](https://tracker.example/pixel.png)");
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain("[Diagram]");
    expect(html).toContain('rel="nofollow ugc noopener noreferrer"');
  });
});
