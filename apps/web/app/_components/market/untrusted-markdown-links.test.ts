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
});
