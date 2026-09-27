import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import zhCNMessages from "@/messages/zh-CN.json";
import zhTWMessages from "@/messages/zh-TW.json";
import { type IntlOptions, withIntl } from "@/test/react";

import { McpReadmeSection, type McpReadmeStatus } from "./mcp-readme-section";

const source = {
  blob: "https://github.com/o/r/blob/abc123/servers/x/README.md",
  raw: "https://raw.githubusercontent.com/o/r/abc123/servers/x/README.md",
};

function render(
  props: Parameters<typeof McpReadmeSection>[0],
  intl?: IntlOptions,
) {
  return renderToStaticMarkup(withIntl(<McpReadmeSection {...props} />, intl));
}

describe("McpReadmeSection", () => {
  it("renders the README as untrusted markdown against its source", () => {
    const html = render({
      markdown:
        '<p align="center"><img src="docs/logo.png" alt="Logo"></p>\n\n[Setup](docs/setup.md)',
      source,
      status: "ok",
    });
    expect(html).toContain('<p align="center">');
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain(
      'href="https://raw.githubusercontent.com/o/r/abc123/servers/x/docs/logo.png"',
    );
    expect(html).toContain(
      'href="https://github.com/o/r/blob/abc123/servers/x/docs/setup.md"',
    );
  });

  it("says when the repository has no README", () => {
    expect(render({ status: "not_found" })).toContain(
      "This repository has no README.",
    );
  });

  it("links a README too large to show to its page", () => {
    const html = render({ source, status: "too_large" });
    expect(html).toContain("The README is too large to show here");
    expect(html).toMatch(
      /<a [^>]*href="https:\/\/github\.com\/o\/r\/blob\/abc123\/servers\/x\/README\.md"[^>]*>open it on GitHub<\/a>/,
    );
    expect(html).toContain('rel="nofollow ugc noopener noreferrer"');
    expect(html).toContain('target="_blank"');

    const withoutSource = render({ status: "too_large" });
    expect(withoutSource).toContain("open it on GitHub");
    expect(withoutSource).not.toMatch(/<a /);
  });

  it("shows nothing while pending, after an error, or for a host it does not read", () => {
    for (const status of [
      "pending",
      "error",
      "unsupported_host",
    ] satisfies McpReadmeStatus[]) {
      expect(render({ markdown: "# Title", source, status })).toBe("");
    }
    expect(render({ markdown: "", status: "ok" })).toBe("");
  });

  it("speaks the visitor's language", () => {
    const zhCN = { locale: "zh-CN", messages: zhCNMessages };
    expect(render({ status: "not_found" }, zhCN)).toContain(
      "该仓库没有 README。",
    );
    expect(render({ source, status: "too_large" }, zhCN)).toMatch(
      /README 过大，无法在此显示，请<a [^>]*>在 GitHub 上查看<\/a>。/,
    );
    const zhTW = { locale: "zh-TW", messages: zhTWMessages };
    expect(render({ status: "not_found" }, zhTW)).toContain(
      "該儲存庫沒有 README。",
    );
    expect(
      render({ markdown: "![](https://x.example/a.png)", status: "ok" }, zhTW),
    ).toContain("[圖片]");
  });
});
