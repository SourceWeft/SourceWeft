// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  LISTED_BADGE_ALT,
  LISTED_BADGE_ETAG,
  LISTED_BADGE_MARK_PATH,
  badgeHtml,
  badgeMarkdown,
  catalogBadgeUrls,
  renderListedBadgeSvg,
} from "./catalog-badge";

const SITE = "https://x";

describe("catalogBadgeUrls", () => {
  it("points an MCP server's badge at its canonical English page", () => {
    expect(
      catalogBadgeUrls({ kind: "mcp", key: "io.github.a/b" }, SITE),
    ).toEqual({
      badgeUrl: "https://x/badge/mcp/io.github.a%2Fb.svg",
      detailUrl:
        "https://x/mcp/io.github.a%2Fb?utm_source=readme&utm_medium=badge",
    });
  });

  it("points a skill's badge at its canonical English page", () => {
    expect(
      catalogBadgeUrls({ kind: "skill", key: "gh-ada-skills-pdf" }, SITE),
    ).toEqual({
      badgeUrl: "https://x/badge/skills/gh-ada-skills-pdf.svg",
      detailUrl:
        "https://x/skills/gh-ada-skills-pdf?utm_source=readme&utm_medium=badge",
    });
  });

  it("never carries a locale prefix, whatever page builds it", () => {
    const urls = catalogBadgeUrls({ kind: "mcp", key: "io.github.a/b" }, SITE);
    expect(urls.detailUrl).not.toMatch(/\/zh-(CN|TW)\//);
    expect(urls.badgeUrl).not.toMatch(/\/zh-(CN|TW)\//);
  });

  it("drops a trailing slash from the site address", () => {
    expect(
      catalogBadgeUrls({ kind: "skill", key: "s" }, "https://x/").badgeUrl,
    ).toBe("https://x/badge/skills/s.svg");
  });

  it("encodes every character that could end a Markdown link or an attribute", () => {
    const urls = catalogBadgeUrls(
      { kind: "mcp", key: "a/b (c)'d\"e<f>g&h!i*j k" },
      SITE,
    );
    for (const url of [urls.badgeUrl, urls.detailUrl.split("?")[0]!]) {
      expect(url).not.toMatch(/[()'"<>&!* ]/);
    }
    expect(urls.badgeUrl).toBe(
      "https://x/badge/mcp/a%2Fb%20%28c%29%27d%22e%3Cf%3Eg%26h%21i%2Aj%20k.svg",
    );
  });
});

describe("snippets", () => {
  const hostile = catalogBadgeUrls(
    { kind: "mcp", key: 'a/b) [x](y "z" <script>&' },
    SITE,
  );

  it("writes a Markdown image link that no identifier can cut short", () => {
    const markdown = badgeMarkdown(
      catalogBadgeUrls({ kind: "mcp", key: "io.github.a/b" }, SITE),
    );
    expect(markdown).toBe(
      "[![Listed on SourceWeft](https://x/badge/mcp/io.github.a%2Fb.svg)](https://x/mcp/io.github.a%2Fb?utm_source=readme&utm_medium=badge)",
    );
    const parts = /^\[!\[([^\]]*)\]\(([^)\s]*)\)\]\(([^)\s]*)\)$/.exec(
      badgeMarkdown(hostile),
    );
    expect(parts?.slice(1)).toEqual([
      LISTED_BADGE_ALT,
      hostile.badgeUrl,
      hostile.detailUrl,
    ]);
  });

  it("writes HTML whose attributes no identifier can escape", () => {
    expect(
      badgeHtml(catalogBadgeUrls({ kind: "skill", key: "pdf" }, SITE)),
    ).toBe(
      '<a href="https://x/skills/pdf?utm_source=readme&amp;utm_medium=badge"><img src="https://x/badge/skills/pdf.svg" alt="Listed on SourceWeft" height="20"></a>',
    );
    const container = document.createElement("div");
    container.innerHTML = badgeHtml(hostile);
    expect(container.children).toHaveLength(1);
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(hostile.detailUrl);
    expect(link.children).toHaveLength(1);
    const image = link.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(hostile.badgeUrl);
    expect(image.getAttribute("alt")).toBe(LISTED_BADGE_ALT);
    expect(container.querySelector("script")).toBeNull();
  });
});

describe("renderListedBadgeSvg", () => {
  const svg = renderListedBadgeSvg();

  it("is well-formed, accessible SVG, 20px high", () => {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    const root = doc.documentElement;
    expect(root.tagName).toBe("svg");
    expect(root.getAttribute("height")).toBe("20");
    expect(root.getAttribute("role")).toBe("img");
    expect(root.getAttribute("aria-label")).toBe(LISTED_BADGE_ALT);
    expect(root.getElementsByTagName("title")[0]?.textContent).toBe(
      LISTED_BADGE_ALT,
    );
    expect(root.textContent).toContain("listed on");
    expect(root.textContent).toContain("SourceWeft");
  });

  it("loads nothing and runs nothing", () => {
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/<foreignObject/i);
    expect(svg).not.toMatch(/<image/i);
    expect(svg).not.toMatch(/<style/i);
    expect(svg).not.toMatch(/\bhref=/i);
    expect(svg).not.toMatch(/url\((?!#)/i);
    expect(svg).not.toMatch(/@import|@font-face/i);
    // Only the SVG namespace is named.
    expect(svg.match(/https?:\/\/[^"]+/g)).toEqual([
      "http://www.w3.org/2000/svg",
    ]);
  });

  it("draws the SourceWeft mark from the generated app icon", () => {
    // `import.meta.url` is not a file URL under jsdom.
    const icon = readFileSync(join(__dirname, "../public/icon.svg"), "utf8");
    const iconPath = /<path d="([^"]+)"/.exec(icon)?.[1];
    expect(iconPath).toBeTruthy();
    expect(LISTED_BADGE_MARK_PATH).toBe(iconPath);
    expect(svg).toContain(`d="${iconPath}"`);
  });

  it("is the same every time, and versioned by its ETag", () => {
    expect(renderListedBadgeSvg()).toBe(svg);
    expect(LISTED_BADGE_ETAG).toBe('"sw-listed-v1"');
  });
});
