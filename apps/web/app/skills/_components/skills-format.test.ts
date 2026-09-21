import { describe, expect, it } from "vitest";

import {
  commitUrl,
  formatCompactCount,
  formatFileSize,
  formatSkillDate,
  formatSkillVersion,
  parseSkillDetailTab,
  repoLabel,
  safeExternalUrl,
  scanFlagLabel,
  shortCommitSha,
  shortSeoText,
  skillCategoryLabel,
  skillCategoryPath,
  skillDashboardInstallPath,
  skillInstallHref,
  skillPath,
  skillTabHref,
  skillTakedownMailto,
  stripSkillFrontmatter,
  UNTRUSTED_LINK_REL,
  untrustedMarkdownLink,
  isolateSkillMarkerTags,
  skillLocalInstallCommand,
  safeSkillLogoUrl,
} from "./skills-format";

describe("paths", () => {
  it("encodes slugs", () => {
    expect(skillPath("pdf-forms")).toBe("/skills/pdf-forms");
    expect(skillPath("a/b c")).toBe("/skills/a%2Fb%20c");
    expect(skillCategoryPath("data-analysis")).toBe(
      "/skills/category/data-analysis",
    );
  });

  it("labels a category from the taxonomy, else from its slug", () => {
    const names = new Map([["data-analysis", "Data & Analysis"]]);
    expect(skillCategoryLabel("data-analysis", names)).toBe("Data & Analysis");
    expect(skillCategoryLabel("data-analysis")).toBe("Data Analysis");
  });
});

describe("detail tabs", () => {
  it("defaults to SKILL.md for a missing or unknown tab", () => {
    expect(parseSkillDetailTab(undefined)).toBe("skill");
    expect(parseSkillDetailTab("readme")).toBe("skill");
    expect(parseSkillDetailTab(["files", "install"])).toBe("files");
    expect(parseSkillDetailTab("versions")).toBe("versions");
    expect(parseSkillDetailTab("install")).toBe("install");
  });

  it("keeps the default tab on the canonical URL", () => {
    expect(skillTabHref("pdf-forms", "skill")).toBe("/skills/pdf-forms");
    expect(skillTabHref("pdf-forms", "files")).toBe(
      "/skills/pdf-forms?tab=files",
    );
  });
});

describe("install links", () => {
  it("goes straight to the dashboard install when signed in", () => {
    expect(skillDashboardInstallPath("pdf-forms")).toBe(
      "/dashboard/skills/pdf-forms?install=1",
    );
    expect(skillInstallHref("pdf-forms", true)).toBe(
      "/dashboard/skills/pdf-forms?install=1",
    );
  });

  it("returns through sign-in to that same path when signed out", () => {
    const href = skillInstallHref("pdf forms", false);
    expect(href).toBe(
      "/auth/sign-in?redirectTo=%2Fdashboard%2Fskills%2Fpdf%2520forms%3Finstall%3D1",
    );
    const redirectTo = new URL(href, "https://x.test").searchParams.get(
      "redirectTo",
    );
    expect(redirectTo).toBe(skillDashboardInstallPath("pdf forms"));
    // A same-site path: never an open redirect.
    expect(redirectTo?.startsWith("/")).toBe(true);
    expect(redirectTo?.startsWith("//")).toBe(false);
  });
});

describe("numbers and dates", () => {
  it("compacts install counts, rounding down", () => {
    expect(formatCompactCount(0)).toBe("0");
    expect(formatCompactCount(999)).toBe("999");
    expect(formatCompactCount(1_000)).toBe("1K");
    expect(formatCompactCount(1_290)).toBe("1.2K");
    expect(formatCompactCount(9_999)).toBe("9.9K");
    expect(formatCompactCount(34_567)).toBe("34K");
    expect(formatCompactCount(999_999)).toBe("999K");
    expect(formatCompactCount(1_250_000)).toBe("1.2M");
    expect(formatCompactCount(-5)).toBe("0");
  });

  it("formats dates in UTC so server and client agree", () => {
    expect(formatSkillDate("2026-09-20T23:30:00.000Z")).toBe("Sep 20, 2026");
    expect(formatSkillDate("2026-01-01T00:00:00+14:00")).toBe("Dec 31, 2025");
  });

  it("returns null for a missing or unparseable date", () => {
    expect(formatSkillDate(null)).toBeNull();
    expect(formatSkillDate(undefined)).toBeNull();
    expect(formatSkillDate("")).toBeNull();
    expect(formatSkillDate("not a date")).toBeNull();
  });

  it("formats file sizes", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(1023)).toBe("1023 B");
    expect(formatFileSize(1024)).toBe("1 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5 MB");
  });

  it("prefixes only numeric versions", () => {
    expect(formatSkillVersion("1.2.0")).toBe("v1.2.0");
    expect(formatSkillVersion("v1.2.0")).toBe("v1.2.0");
    expect(formatSkillVersion("main-abc1234")).toBe("main-abc1234");
  });

  it("shortens SEO text on a word-safe boundary with an ellipsis", () => {
    expect(shortSeoText("  a \n b  ")).toBe("a b");
    const long = shortSeoText("word ".repeat(100), 50);
    expect(long.length).toBeLessThanOrEqual(50);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("source attribution", () => {
  it("shortens a commit sha", () => {
    expect(shortCommitSha("0123456789abcdef0123456789abcdef01234567")).toBe(
      "0123456",
    );
    expect(shortCommitSha(null)).toBeNull();
  });

  it("only lets http(s) URLs become links", () => {
    expect(safeExternalUrl("https://github.com/a/b")).toBe(
      "https://github.com/a/b",
    );
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("data:text/html,x")).toBeNull();
    expect(safeExternalUrl("not a url")).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
  });

  it("labels a repository", () => {
    expect(repoLabel("https://github.com/anthropics/skills")).toBe(
      "anthropics/skills",
    );
    expect(repoLabel("https://github.com/anthropics/skills.git/")).toBe(
      "anthropics/skills",
    );
    expect(repoLabel("https://gitlab.com/group/repo")).toBe(
      "gitlab.com/group/repo",
    );
  });

  it("builds a commit permalink for GitHub only", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(commitUrl("https://github.com/anthropics/skills", sha)).toBe(
      `https://github.com/anthropics/skills/commit/${sha}`,
    );
    expect(commitUrl("https://github.com/anthropics/skills.git", sha)).toBe(
      `https://github.com/anthropics/skills/commit/${sha}`,
    );
    expect(commitUrl("https://gitlab.com/group/repo", sha)).toBeNull();
    expect(commitUrl("https://github.com/a/b", "../../evil")).toBeNull();
    expect(commitUrl(null, sha)).toBeNull();
    expect(commitUrl("https://github.com/a/b", null)).toBeNull();
  });

  it("prefills the takedown mail with the slug", () => {
    const href = skillTakedownMailto("pdf forms&x");
    expect(href).toBe(
      "mailto:support@sourceweft.com?subject=Skill%20takedown%3A%20pdf%20forms%26x",
    );
    const url = new URL(href);
    expect(url.protocol).toBe("mailto:");
    expect(url.pathname).toBe("support@sourceweft.com");
    expect(url.searchParams.get("subject")).toBe("Skill takedown: pdf forms&x");
  });

  it("puts a scan flag in words, and shows an unknown one as it is", () => {
    expect(scanFlagLabel("binary:executable")).toBe(
      "Ships an executable binary",
    );
    expect(scanFlagLabel("future:flag")).toBe("future:flag");
  });
});

describe("stripSkillFrontmatter", () => {
  it("strips a complete leading YAML block", () => {
    expect(
      stripSkillFrontmatter(
        "---\nname: pdf\ndescription: x\n---\n# PDF\n\nBody",
      ),
    ).toBe("# PDF\n\nBody");
  });

  it("handles CRLF and a byte-order mark", () => {
    expect(
      stripSkillFrontmatter("\uFEFF---\r\nname: pdf\r\n---\r\n# PDF"),
    ).toBe("# PDF");
  });

  it("leaves a thematic break later in the body alone", () => {
    const body = "# PDF\n\n---\n\nnot: frontmatter\n\n---\n\nEnd";
    expect(stripSkillFrontmatter(body)).toBe(body);
  });

  it("leaves an unterminated block alone rather than eating the document", () => {
    const body = "---\nname: pdf\n# PDF";
    expect(stripSkillFrontmatter(body)).toBe(body);
  });

  it("is empty for missing or frontmatter-only text", () => {
    expect(stripSkillFrontmatter(null)).toBe("");
    expect(stripSkillFrontmatter("---\nname: pdf\n---")).toBe("");
  });
});

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

describe("formatSkillVersion", () => {
  it("prefixes version numbers and leaves commit prefixes alone", () => {
    expect(formatSkillVersion("1.2.0")).toBe("v1.2.0");
    expect(formatSkillVersion("2.0.0-beta.1")).toBe("v2.0.0-beta.1");
    // A commit-hash prefix that happens to start with a digit.
    expect(formatSkillVersion("5bf4e7801107")).toBe("5bf4e7801107");
    expect(formatSkillVersion("main")).toBe("main");
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

describe("skillLocalInstallCommand", () => {
  const sha = "5bf4e78011075bcfc0dc295f0724994cd123ee71";
  it("pins the upstream command to the indexed commit and directory", () => {
    expect(
      skillLocalInstallCommand({
        repoUrl: "https://github.com/obra/superpowers",
        commitSha: sha,
        repoSubpath: "skills/test-driven-development",
      }),
    ).toBe(
      `npx skills add https://github.com/obra/superpowers/tree/${sha}/skills/test-driven-development`,
    );
    // A skill at the repository root has no directory to name.
    expect(
      skillLocalInstallCommand({
        repoUrl: "https://github.com/obra/superpowers.git",
        commitSha: sha.toUpperCase(),
        repoSubpath: "",
      }),
    ).toBe(`npx skills add https://github.com/obra/superpowers/tree/${sha}`);
  });

  it("gives no command rather than an unsafe or unpinned one", () => {
    const repoUrl = "https://github.com/obra/superpowers";
    for (const source of [
      { repoUrl, commitSha: "5bf4e78", repoSubpath: "" },
      { repoUrl, commitSha: null, repoSubpath: "" },
      { repoUrl: "https://gitlab.com/a/b", commitSha: sha, repoSubpath: "" },
      { repoUrl, commitSha: sha, repoSubpath: "skills/$(rm -rf ~)" },
      { repoUrl, commitSha: sha, repoSubpath: "a/../../b" },
      { repoUrl: "https://github.com/a/b; curl x | sh", commitSha: sha },
    ]) {
      expect(skillLocalInstallCommand(source)).toBeNull();
    }
  });
});

describe("safeSkillLogoUrl", () => {
  it("lets through a PNG thumbnail or an https image, and nothing else", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(safeSkillLogoUrl(png)).toBe(png);
    expect(safeSkillLogoUrl("https://github.com/obra.png?size=128")).toBe(
      "https://github.com/obra.png?size=128",
    );
    for (const bad of [
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:text/html;base64,PGI+",
      "http://example.com/a.png",
      "https://user:pw@example.com/a.png",
      "javascript:alert(1)",
      "",
      null,
    ]) {
      expect(safeSkillLogoUrl(bad)).toBeNull();
    }
  });
});
