import { describe, expect, it } from "vitest";

import {
  UNTRUSTED_LINK_REL,
  untrustedMarkdownLink,
} from "./untrusted-markdown-links";

describe("untrustedMarkdownLink", () => {
  it("opens http(s) and mailto links in a new tab as nofollow ugc", () => {
    expect(UNTRUSTED_LINK_REL).toBe("nofollow ugc noopener noreferrer");
    for (const href of [
      "https://example.com/docs",
      "http://example.com",
      "mailto:someone@example.com",
      "HTTPS://EXAMPLE.COM/x",
    ]) {
      expect(untrustedMarkdownLink(href)).toMatchObject({
        kind: "external",
        rel: UNTRUSTED_LINK_REL,
        target: "_blank",
      });
    }
  });

  it("keeps in-page anchors in the page", () => {
    expect(untrustedMarkdownLink("#usage")).toEqual({
      href: "#usage",
      kind: "anchor",
    });
  });

  it("refuses scripts, data, protocol-relative and repository-relative targets", () => {
    for (const href of [
      "javascript:alert(1)",
      " JaVaScRiPt:alert(1)",
      "data:text/html,<script>1</script>",
      "vbscript:x",
      "//evil.example/x",
      "references/guide.md",
      "/dashboard",
      "",
      null,
      undefined,
    ]) {
      expect(untrustedMarkdownLink(href)).toEqual({ kind: "text" });
    }
  });

  describe("with the document's own address", () => {
    const base = "https://github.com/o/r/blob/abc123/servers/x/README.md";

    it("resolves relative references there", () => {
      for (const [href, expected] of [
        [
          "docs/setup.md",
          "https://github.com/o/r/blob/abc123/servers/x/docs/setup.md",
        ],
        ["./x.md", "https://github.com/o/r/blob/abc123/servers/x/x.md"],
        ["../y.md", "https://github.com/o/r/blob/abc123/servers/y.md"],
        [
          "?plain=1",
          "https://github.com/o/r/blob/abc123/servers/x/README.md?plain=1",
        ],
        [
          "#usage",
          "https://github.com/o/r/blob/abc123/servers/x/README.md#usage",
        ],
        [
          "my notes.md",
          "https://github.com/o/r/blob/abc123/servers/x/my%20notes.md",
        ],
      ] as const) {
        expect(untrustedMarkdownLink(href, base)).toEqual({
          href: expected,
          kind: "external",
          rel: UNTRUSTED_LINK_REL,
          target: "_blank",
        });
      }
    });

    it("treats absolute links as it does without one", () => {
      expect(untrustedMarkdownLink("https://example.com/a", base)).toEqual(
        untrustedMarkdownLink("https://example.com/a"),
      );
      expect(untrustedMarkdownLink("mailto:a@example.com", base)).toEqual(
        untrustedMarkdownLink("mailto:a@example.com"),
      );
    });

    it("still refuses scripts, other schemes, and root- or protocol-relative paths", () => {
      for (const href of [
        "javascript:alert(1)",
        "JAVASCRIPT:alert(1)",
        "java\tscript:alert(1)",
        "data:text/html,<script>1</script>",
        "vbscript:x",
        "tel:123",
        "/dashboard",
        "//evil.example/x",
        "\\\\evil.example/x",
        "/\\evil.example/x",
        "\u0000//evil.example/x",
        "\u0001/dashboard",
        "/\t/evil.example/x",
        "",
        null,
      ]) {
        expect(untrustedMarkdownLink(href, base)).toEqual({ kind: "text" });
      }
    });

    it("resolves nothing against an address that is not http(s)", () => {
      for (const bad of [
        "not a url",
        "javascript:alert(1)//",
        "file:///etc/",
      ]) {
        expect(untrustedMarkdownLink("docs/setup.md", bad)).toEqual({
          kind: "text",
        });
      }
    });
  });
});
