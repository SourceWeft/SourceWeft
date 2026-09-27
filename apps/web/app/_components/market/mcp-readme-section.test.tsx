import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import zhCNMessages from "@/messages/zh-CN.json";
import zhTWMessages from "@/messages/zh-TW.json";
import { type IntlOptions, withIntl } from "@/test/react";

import type { McpReadmePayload } from "@/lib/mcp-readme";

import {
  McpReadmeRepositoryLink,
  McpReadmeSection,
  McpReadmeSourceLine,
  type McpReadmeStatus,
} from "./mcp-readme-section";

const source = {
  blobUrl: "https://github.com/o/r/blob/abc123/servers/x/README.md",
  rawUrl: "https://raw.githubusercontent.com/o/r/abc123/servers/x/README.md",
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

const SHA = "0123456789abcdef0123456789abcdef01234567";

function readme(
  status: McpReadmeStatus,
  patch: Partial<McpReadmePayload> = {},
): McpReadmePayload {
  return {
    status,
    ...(status === "ok" ? { markdown: "# Title" } : {}),
    source: {
      blobUrl: `https://github.com/o/r/blob/${SHA}/mcp/README.md`,
      path: "mcp/README.md",
      rawUrl: `https://raw.githubusercontent.com/o/r/${SHA}/mcp/README.md`,
      ref: SHA,
      repoUrl: "https://github.com/o/r",
    },
    ...patch,
  };
}

describe("McpReadmeSection with a detail response's readme", () => {
  it("takes the payload as it is", () => {
    const html = renderToStaticMarkup(
      withIntl(
        <McpReadmeSection
          {...readme("ok", {
            markdown: "[Setup](docs/setup.md) ![Diagram](img/flow.png)",
          })}
        />,
      ),
    );
    expect(html).toContain(
      `href="https://github.com/o/r/blob/${SHA}/mcp/docs/setup.md"`,
    );
    expect(html).toContain(
      `href="https://raw.githubusercontent.com/o/r/${SHA}/mcp/img/flow.png"`,
    );
    expect(html).toContain("[Diagram]");
    expect(html).not.toMatch(/<img/i);
  });

  it("leaves relative links as text when the README's addresses are unknown", () => {
    const html = render({
      markdown: "[Setup](docs/setup.md) and [site](https://example.com)",
      source: { blobUrl: source.blobUrl, rawUrl: null },
      status: "ok",
    });
    expect(html).not.toContain("docs/setup.md");
    expect(html).toContain("<span>Setup</span>");
    expect(html).toContain('href="https://example.com/"');
  });

  it("links a README too large to show even without its raw address", () => {
    expect(
      render({
        source: { blobUrl: source.blobUrl, rawUrl: null },
        status: "too_large",
      }),
    ).toContain(`href="${source.blobUrl}"`);
  });
});

function renderLine(node: ReactElement, intl?: IntlOptions) {
  return renderToStaticMarkup(withIntl(node, intl));
}

describe("McpReadmeSourceLine", () => {
  it("names the README's path, linked to it at the pinned commit", () => {
    const html = renderLine(<McpReadmeSourceLine readme={readme("ok")} />);
    expect(html).toMatch(
      new RegExp(
        `Source: <a [^>]*href="https://github\\.com/o/r/blob/${SHA}/mcp/README\\.md"[^>]*>mcp/README\\.md</a> at commit <code[^>]*>0123456</code>`,
      ),
    );
    expect(html).toContain('rel="nofollow ugc noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it("leaves the commit out when none was pinned", () => {
    const base = readme("ok");
    const html = renderLine(
      <McpReadmeSourceLine
        readme={{ ...base, source: { ...base.source!, ref: null } }}
      />,
    );
    expect(html).toMatch(/Source: <a [^>]*>mcp\/README\.md<\/a><\/p>$/);
  });

  it("names the path without a link when the file has no safe address", () => {
    const base = readme("ok");
    const html = renderLine(
      <McpReadmeSourceLine
        readme={{
          ...base,
          source: { ...base.source!, blobUrl: "javascript:alert(1)" },
        }}
      />,
    );
    expect(html).not.toMatch(/<a /);
    expect(html).toContain("mcp/README.md");
  });

  it("is only under a README that is shown", () => {
    for (const status of [
      "not_found",
      "too_large",
      "error",
      "unsupported_host",
      "pending",
    ] satisfies McpReadmeStatus[]) {
      expect(renderLine(<McpReadmeSourceLine readme={readme(status)} />)).toBe(
        "",
      );
    }
    expect(
      renderLine(
        <McpReadmeSourceLine readme={readme("ok", { source: null })} />,
      ),
    ).toBe("");
    expect(renderLine(<McpReadmeSourceLine readme={null} />)).toBe("");
  });

  it("speaks the visitor's language", () => {
    expect(
      renderLine(<McpReadmeSourceLine readme={readme("ok")} />, {
        locale: "zh-TW",
        messages: zhTWMessages,
      }),
    ).toMatch(
      /來源：<a [^>]*>mcp\/README\.md<\/a>，提交 <code[^>]*>0123456<\/code>/,
    );
  });
});

describe("McpReadmeRepositoryLink", () => {
  it("offers the repository when the README could not be read", () => {
    for (const status of [
      "error",
      "unsupported_host",
    ] satisfies McpReadmeStatus[]) {
      const html = renderLine(
        <McpReadmeRepositoryLink readme={readme(status)} />,
      );
      expect(html).toMatch(
        /<a [^>]*href="https:\/\/github\.com\/o\/r"[^>]*>Read the README in its repository/,
      );
      expect(html).toContain('rel="nofollow ugc noopener noreferrer"');
    }
  });

  it("offers nothing otherwise", () => {
    for (const status of [
      "ok",
      "not_found",
      "too_large",
      "pending",
    ] satisfies McpReadmeStatus[]) {
      expect(
        renderLine(<McpReadmeRepositoryLink readme={readme(status)} />),
      ).toBe("");
    }
    expect(
      renderLine(
        <McpReadmeRepositoryLink readme={readme("error", { source: null })} />,
      ),
    ).toBe("");
  });

  it("speaks the visitor's language", () => {
    expect(
      renderLine(<McpReadmeRepositoryLink readme={readme("error")} />, {
        locale: "zh-CN",
        messages: zhCNMessages,
      }),
    ).toContain("在仓库中阅读 README");
  });
});
