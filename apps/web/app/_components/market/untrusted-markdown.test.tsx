import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  isolateSkillMarkerTags,
  UntrustedMarkdown,
} from "./untrusted-markdown";

function render(markdown: string) {
  return renderToStaticMarkup(
    <UntrustedMarkdown imagePlaceholder="Image" mode="skill">
      {markdown}
    </UntrustedMarkdown>,
  );
}

const sha = "0123456789abcdef0123456789abcdef01234567";
const baseUrl = {
  blob: `https://github.com/o/r/blob/${sha}/servers/x/README.md`,
  raw: `https://raw.githubusercontent.com/o/r/${sha}/servers/x/README.md`,
};

function renderReadme(markdown: string, base?: typeof baseUrl) {
  return renderToStaticMarkup(
    <UntrustedMarkdown baseUrl={base} imagePlaceholder="Image" mode="readme">
      {markdown}
    </UntrustedMarkdown>,
  );
}

function anchors(html: string) {
  return html.match(/<a [^>]*>/g) ?? [];
}

function hrefs(html: string) {
  return [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) =>
    match[1]!.replaceAll("&amp;", "&"),
  );
}

describe("UntrustedMarkdown in skill mode", () => {
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

  it("shows an author's marker tags as text and still parses the fence under them", () => {
    const html = render(
      ["<Good>", "```ts", "ok();", "```", "</Good>"].join("\n"),
    );
    expect(html).toContain("&lt;Good&gt;");
    expect(html).toContain('data-streamdown="code-block"');
  });
});

describe("UntrustedMarkdown in readme mode", () => {
  it("renders the HTML READMEs are written with", () => {
    const html = renderReadme(
      [
        '<h1 align="center">My Server</h1>',
        "",
        '<p align="center">A <kbd>Ctrl</kbd> key<br>on two lines</p>',
        "",
        "<details>",
        "<summary>Configuration</summary>",
        "",
        "Set **TOKEN** first.",
        "",
        "</details>",
      ].join("\n"),
    );
    // The page has its own <h1>; a centred README title stays centred.
    expect(html).toMatch(/<h2 class="[^"]*text-center[^"]*">My Server<\/h2>/);
    expect(html).toContain('<p align="center">');
    expect(html).toContain("<kbd>Ctrl</kbd>");
    expect(html).toContain("<br/>");
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>Configuration</summary>");
    // Markdown inside the HTML block is still markdown.
    expect(html).toMatch(/<(strong|span)[^>]*>TOKEN</);
  });

  it("strips scripts, styles, frames, forms, event handlers and unsafe URLs", () => {
    const html = renderReadme(
      [
        '<script>alert("script")</script>',
        "",
        "<style>body { display: none }</style>",
        "",
        '<iframe src="https://evil.example/frame"></iframe>',
        "",
        '<form action="https://evil.example/login"><input type="password" name="p"><button>Sign in</button></form>',
        "",
        '<svg onload="alert(1)"><text>vector</text></svg>',
        "",
        '<b onclick="alert(1)" style="color: red" class="big">bold</b>',
        '<a href="javascript:alert(1)">run</a>',
        '<a href="data:text/html,<script>alert(1)</script>">data</a>',
        '<a href="https://example.com" onmouseover="alert(1)" target="_self">site</a>',
        "[md](javascript:alert(1))",
      ].join("\n"),
      baseUrl,
    );
    for (const forbidden of [
      /<script/i,
      /<style/i,
      /<iframe/i,
      /<form/i,
      /<svg/i,
      /<button/i,
      /type="password"/i,
      /\son[a-z]+=/i,
      /style="color/i,
      /class="big"/i,
      /javascript:/i,
      /data:/i,
      /alert/i,
      /display: none/i,
      /_self/i,
    ]) {
      expect(html).not.toMatch(forbidden);
    }
    // What those elements held is dropped with them, not shown as source.
    expect(html).not.toContain("Sign in");
    expect(html).not.toContain("vector");
    expect(html).toContain("<b>bold</b>");
    expect(html).toContain("<span>run</span>");
    expect(html).toContain("<span>data</span>");
    expect(anchors(html)).toEqual([
      '<a class="font-medium underline underline-offset-4" href="https://example.com/" rel="nofollow ugc noopener noreferrer" target="_blank">',
    ]);
  });

  it("does not load images, raw <img> or markdown", () => {
    const html = renderReadme(
      [
        '<img src="https://tracker.example/pixel.png" alt="Pixel" onerror="alert(1)">',
        "",
        '<picture><source srcset="https://tracker.example/a.png"><img src="https://tracker.example/b.png" alt="Picture"></picture>',
        "",
        "![Diagram](https://tracker.example/diagram.png) ![](https://tracker.example/untitled.png)",
        "",
        "![Inline](data:image/png;base64,AAAA)",
      ].join("\n"),
    );
    expect(html).not.toMatch(/<img|<picture|<source|srcset/i);
    expect(html).not.toContain("data:");
    for (const label of ["Pixel", "Picture", "Diagram"]) {
      expect(html).toContain(`[${label}]`);
    }
    expect(html).toContain("[Image]");
    expect(html).toContain("<span>[Inline]</span>");
    expect(hrefs(html)).toEqual([
      "https://tracker.example/pixel.png",
      "https://tracker.example/b.png",
      "https://tracker.example/diagram.png",
      "https://tracker.example/untitled.png",
    ]);
    for (const anchor of anchors(html)) {
      expect(anchor).toContain('rel="nofollow ugc noopener noreferrer"');
    }
  });

  it("keeps a badge's own link and does not nest the picture's", () => {
    const html = renderReadme(
      [
        "[![npm](https://img.shields.io/npm/v/x.svg)](https://www.npmjs.com/package/x)",
        '<a href="https://ci.example"><img src="https://ci.example/badge.svg" alt="CI"></a>',
      ].join("\n"),
    );
    expect(hrefs(html)).toEqual([
      "https://www.npmjs.com/package/x",
      "https://ci.example/",
    ]);
    expect(html).toContain("<span>[npm]</span>");
    expect(html).toContain("<span>[CI]</span>");
  });

  it("resolves relative links against the README's page at its commit", () => {
    const html = renderReadme(
      [
        "[setup](docs/setup.md) [same](./CHANGELOG.md) [parent](../../LICENSE)",
        "[plain](?plain=1)",
        '<a href="examples/basic.ts">example</a>',
      ].join("\n"),
      baseUrl,
    );
    expect(hrefs(html)).toEqual([
      `https://github.com/o/r/blob/${sha}/servers/x/docs/setup.md`,
      `https://github.com/o/r/blob/${sha}/servers/x/CHANGELOG.md`,
      `https://github.com/o/r/blob/${sha}/LICENSE`,
      `https://github.com/o/r/blob/${sha}/servers/x/README.md?plain=1`,
      `https://github.com/o/r/blob/${sha}/servers/x/examples/basic.ts`,
    ]);
    for (const anchor of anchors(html)) {
      expect(anchor).toContain('rel="nofollow ugc noopener noreferrer"');
      expect(anchor).toContain('target="_blank"');
    }
  });

  it("resolves relative images against the raw file, still without loading them", () => {
    const html = renderReadme(
      [
        "![Architecture](docs/architecture.png)",
        '<img src="./assets/logo.svg" alt="Logo" width="120">',
      ].join("\n"),
      baseUrl,
    );
    expect(html).not.toMatch(/<img/i);
    expect(hrefs(html)).toEqual([
      `https://raw.githubusercontent.com/o/r/${sha}/servers/x/docs/architecture.png`,
      `https://raw.githubusercontent.com/o/r/${sha}/servers/x/assets/logo.svg`,
    ]);
    expect(html).toContain("[Architecture]");
    expect(html).toContain("[Logo]");
  });

  it("sends anchors to the README's page when it is known, and keeps them in the page otherwise", () => {
    const markdown = "[Usage](#usage)";
    expect(hrefs(renderReadme(markdown, baseUrl))).toEqual([
      `https://github.com/o/r/blob/${sha}/servers/x/README.md#usage`,
    ]);
    const inPage = renderReadme(markdown);
    expect(anchors(inPage)).toEqual([
      '<a class="font-medium underline underline-offset-4" href="#usage">',
    ]);
  });

  it("leaves relative links as text without a base, and root- or protocol-relative ones always", () => {
    const relative =
      "[setup](docs/setup.md) [same](./x.md) [parent](../y.md) ![Logo](logo.png)";
    const withoutBase = renderReadme(relative);
    expect(withoutBase).not.toMatch(/<a /);
    expect(withoutBase).toContain("<span>setup</span>");
    expect(withoutBase).toContain("<span>[Logo]</span>");
    expect(withoutBase).not.toContain("blocked");

    const withBase = renderReadme(
      "[root](/docs/x.md) [host](//evil.example/x)",
      baseUrl,
    );
    expect(withBase).not.toMatch(/<a /);
    expect(withBase).toContain("<span>root</span>");
    expect(withBase).toContain("<span>host</span>");
  });

  it("runs nothing executable: diagrams and math stay source text", () => {
    const html = renderReadme(
      ["```mermaid", "graph TD; A-->B", "```", "", "$$x^2$$"].join("\n"),
    );
    expect(html).toContain('data-language="mermaid"');
    expect(html).not.toMatch(/<svg[^>]*mermaid|katex/i);
    expect(html).toContain("$$x^2$$");
  });
});

describe("isolateSkillMarkerTags", () => {
  it("frees the code fence under an author's own tag", () => {
    const out = isolateSkillMarkerTags(
      ["<Good>", "```ts", "ok();", "```", "Clear name", "</Good>"].join("\n"),
    );
    expect(out).toBe(
      [
        "`<Good>`",
        "",
        "```ts",
        "ok();",
        "```",
        "Clear name",
        "",
        "`</Good>`",
      ].join("\n"),
    );
  });

  it("leaves real HTML blocks, inline tags and fenced content alone", () => {
    const source = [
      "<details>",
      "text with <b>inline</b> tag",
      "```html",
      "<Good>",
      "```",
      "~~~~",
      "```",
      "<Bad>",
      "~~~~",
    ].join("\n");
    expect(isolateSkillMarkerTags(source)).toBe(source);
  });
});
