import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GetMarketSkillResponse } from "@sourceweft/market-sdk";

const market = vi.hoisted(() => ({
  getPublicSkill: vi.fn(),
  listPublicSkillCategories: vi.fn(),
  listPublicSkills: vi.fn(),
}));
const auth = vi.hoisted(() => ({ isSignedIn: false }));

vi.mock("../../../lib/market-skills", () => ({
  ...market,
  isMarketNotFound: (error: unknown) =>
    (error as { status?: number } | null)?.status === 404,
}));
vi.mock("../../_landing/auth-state-server", () => ({
  resolveInitialLandingAuthState: async () => ({
    isPending: false,
    isSignedIn: auth.isSignedIn,
    user: null,
  }),
}));
vi.mock("../../_landing/components/sourceweft-header", () => ({
  SourceWeftHeader: () => null,
}));
vi.mock("../../_landing/components/sourceweft-footer", () => ({
  SourceWeftFooter: () => null,
}));

import PublicSkillDetailPage, { generateMetadata } from "./page";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function response(
  patch: Partial<GetMarketSkillResponse> = {},
  skillPatch: Partial<GetMarketSkillResponse["skill"]> = {},
): GetMarketSkillResponse {
  return {
    files: [
      {
        contentHash: "a".repeat(64),
        mimeType: "text/markdown",
        path: "SKILL.md",
        sizeBytes: 2048,
      },
      {
        contentHash: "b".repeat(64),
        mimeType: null,
        path: "scripts/fill.py",
        sizeBytes: 512,
      },
    ],
    scanFlags: [],
    skill: {
      author: "anthropics",
      capability: "executable",
      categories: ["documents"],
      description: "Fill PDF forms.",
      logo: null,
      displayName: "PDF Forms",
      installCount: 1290,
      license: "MIT",
      listedAt: "2026-09-01T00:00:00.000Z",
      name: "pdf-forms",
      repoUrl: "https://github.com/anthropics/skills",
      slug: "pdf-forms",
      sourceUrl: `https://github.com/anthropics/skills/tree/${SHA}/pdf`,
      updatedAt: "2026-09-15T00:00:00.000Z",
      verified: true,
      version: "1.2.0",
      ...skillPatch,
    },
    skillMd:
      "---\nname: pdf-forms\ndescription: secret-frontmatter\n---\n# Using PDF Forms\n\n<script>alert(1)</script>\n\nSee [docs](https://example.com).",
    source: {
      commitSha: SHA,
      committedAt: "2026-09-14T00:00:00.000Z",
      repoSubpath: "pdf",
      repoUrl: "https://github.com/anthropics/skills",
      sourceUrl: `https://github.com/anthropics/skills/tree/${SHA}/pdf`,
    },
    versions: [
      {
        commitSha: SHA,
        committedAt: "2026-09-14T00:00:00.000Z",
        isCurrent: true,
        publishedAt: "2026-09-15T00:00:00.000Z",
        version: "1.2.0",
      },
      {
        commitSha: null,
        committedAt: null,
        isCurrent: false,
        publishedAt: null,
        version: "1.1.0",
      },
    ],
    ...patch,
  };
}

async function render(tab?: string) {
  const element = await PublicSkillDetailPage({
    params: Promise.resolve({ slug: "pdf-forms" }),
    searchParams: Promise.resolve(tab ? { tab } : {}),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  auth.isSignedIn = false;
  market.getPublicSkill.mockReset().mockResolvedValue(response());
  market.listPublicSkillCategories.mockReset().mockResolvedValue({
    items: [
      { count: 4, description: null, name: "Documents", slug: "documents" },
    ],
    total: 4,
  });
  market.listPublicSkills
    .mockReset()
    .mockResolvedValue({ items: [], nextCursor: null });
});

describe("public skill detail page", () => {
  it("renders the header facts", async () => {
    const html = await render();
    expect(html).toContain("PDF Forms");
    expect(html).toContain("Fill PDF forms.");
    expect(html).toContain("anthropics");
    expect(html).toContain("v1.2.0");
    expect(html).toContain("MIT");
    expect(html).toContain("1.2K installs");
    expect(html).toContain("Verified");
    expect(html).toContain("Includes scripts");
    expect(html).toContain("Listed Sep 1, 2026");
    expect(html).toContain("Updated Sep 15, 2026");
    expect(html).toContain('href="/skills/category/documents"');
    expect(html).toContain("Documents");
  });

  it("hides a zero install count and names a missing license", async () => {
    market.getPublicSkill.mockResolvedValue(
      response({}, { installCount: 0, license: null, verified: false }),
    );
    const html = await render();
    expect(html).not.toContain("installs");
    expect(html).toContain("No license");
    expect(html).not.toContain("Verified");
  });

  it("renders SKILL.md without its frontmatter and without raw HTML", async () => {
    const html = await render();
    expect(html).toContain("Using PDF Forms");
    expect(html).not.toContain("secret-frontmatter");
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toMatch(
      /<a [^>]*href="https:\/\/example\.com\/"[^>]*rel="nofollow ugc noopener noreferrer"[^>]*target="_blank"/,
    );
  });

  it("always carries the attribution block", async () => {
    for (const tab of [undefined, "files", "versions", "install"]) {
      const html = await render(tab);
      expect(html).toContain('href="https://github.com/anthropics/skills"');
      expect(html).toContain("anthropics/skills");
      expect(html).toContain(
        `href="https://github.com/anthropics/skills/tree/${SHA}/pdf"`,
      );
      expect(html).toContain(
        `href="https://github.com/anthropics/skills/commit/${SHA}"`,
      );
      expect(html).toContain("0123456");
      expect(html).toContain(
        "Content belongs to its original authors. SourceWeft indexes it from a public repository.",
      );
      expect(html).toContain(
        'href="mailto:support@sourceweft.com?subject=Skill%20takedown%3A%20pdf-forms"',
      );
      expect(html).toContain("Report or request removal");
    }
  });

  it("lists files without contents", async () => {
    const html = await render("files");
    expect(html).toContain("scripts/fill.py");
    expect(html).toContain("2 KB");
    expect(html).toContain("text/markdown");
    expect(html).toContain("available once the skill is installed");
    expect(html).not.toContain("Using PDF Forms");
  });

  it("lists versions with the current one marked", async () => {
    const html = await render("versions");
    expect(html).toContain("v1.1.0");
    expect(html).toContain("Current");
    expect(html).toContain("Published Sep 15, 2026");
  });

  it("sends a signed-out visitor through sign-in back to the install", async () => {
    const html = await render("install");
    expect(html).toContain(
      'href="/auth/sign-in?redirectTo=%2Fdashboard%2Fskills%2Fpdf-forms%3Finstall%3D1"',
    );
    expect(html).toContain("Add to SourceWeft");
    // The chat alternative names the skill by its unique slug, as a skill.
    expect(html).toContain("Install the skill pdf-forms");
  });

  it("sends a signed-in visitor straight to the dashboard install", async () => {
    auth.isSignedIn = true;
    const html = await render();
    expect(html).toContain('href="/dashboard/skills/pdf-forms?install=1"');
    expect(html).not.toContain("/auth/sign-in");
  });

  it("shows scan flags plainly, and nothing when there are none", async () => {
    expect(await render()).not.toContain("Automated scan notes");
    market.getPublicSkill.mockResolvedValue(
      response({ scanFlags: ["binary:executable", "future:flag"] }),
    );
    const html = await render();
    expect(html).toContain("Automated scan notes");
    expect(html).toContain("Ships an executable binary");
    expect(html).toContain("future:flag");
  });

  it("never links a non-http source address", async () => {
    market.getPublicSkill.mockResolvedValue(
      response(
        {
          source: {
            commitSha: SHA,
            committedAt: null,
            repoSubpath: null,
            repoUrl: "javascript:alert(1)",
            sourceUrl: "javascript:alert(2)",
          },
        },
        { repoUrl: null, sourceUrl: null },
      ),
    );
    const html = await render();
    expect(html).not.toContain("javascript:");
    expect(html).toContain("source repository not recorded");
  });

  it("emits SoftwareSourceCode JSON-LD", async () => {
    const html = await render();
    const blocks = [
      ...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g),
    ].map((match) => JSON.parse(match[1]!) as Record<string, unknown>);
    const code = blocks.find(
      (block) => block["@type"] === "SoftwareSourceCode",
    );
    expect(code).toMatchObject({
      author: { name: "anthropics" },
      codeRepository: "https://github.com/anthropics/skills",
      description: "Fill PDF forms.",
      license: "MIT",
      name: "PDF Forms",
    });
    expect(String(code?.url)).toMatch(/\/skills\/pdf-forms$/);
  });

  it("404s what the market says is not public, and 5xxs an outage", async () => {
    market.getPublicSkill.mockRejectedValue({ status: 404 });
    await expect(render()).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });

    const outage = Object.assign(new Error("down"), { status: 503 });
    market.getPublicSkill.mockRejectedValue(outage);
    await expect(render()).rejects.toBe(outage);
  });
});

describe("generateMetadata", () => {
  it("canonicalises every tab to the bare skill URL and indexes only the default", async () => {
    const base = await generateMetadata({
      params: Promise.resolve({ slug: "pdf-forms" }),
      searchParams: Promise.resolve({}),
    });
    expect(base.title).toBe("PDF Forms Agent Skill");
    expect(String(base.alternates?.canonical)).toMatch(/\/skills\/pdf-forms$/);
    expect(base.robots).toBeUndefined();

    const files = await generateMetadata({
      params: Promise.resolve({ slug: "pdf-forms" }),
      searchParams: Promise.resolve({ tab: "files" }),
    });
    expect(String(files.alternates?.canonical)).toMatch(/\/skills\/pdf-forms$/);
    expect(files.robots).toMatchObject({ index: false });
  });
});
