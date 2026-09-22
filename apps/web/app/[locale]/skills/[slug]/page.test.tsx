import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GetMarketSkillResponse } from "@sourceweft/market-sdk";

const market = vi.hoisted(() => ({
  getPublicSkill: vi.fn(),
  listPublicSkillCategories: vi.fn(),
  listPublicSkills: vi.fn(),
}));
const auth = vi.hoisted(() => ({ isSignedIn: false }));
const reviews = vi.hoisted(() => ({ getPublicSkillReviews: vi.fn() }));
vi.mock("../../../../lib/public-skill-reviews", () => reviews);

vi.mock("../../../../lib/market-skills", () => ({
  ...market,
  marketSkillLocale: (locale: string) => locale,
  isMarketNotFound: (error: unknown) =>
    (error as { status?: number } | null)?.status === 404,
}));
vi.mock("../../../_landing/auth-state-server", () => ({
  resolveInitialLandingAuthState: async () => ({
    isPending: false,
    isSignedIn: auth.isSignedIn,
    user: null,
  }),
}));
vi.mock("../../../_landing/components/sourceweft-header", () => ({
  SourceWeftHeader: () => null,
}));
vi.mock("../../../_landing/components/sourceweft-footer", () => ({
  SourceWeftFooter: () => null,
}));
// next-intl reads its request config through the Next plugin, which a unit
// test does not have: serve the real English catalog directly instead.
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = (await import("../../../../messages/en.json")).default;
  return {
    getTranslations: async (
      input?: string | { locale?: string; namespace?: string },
    ) =>
      createTranslator({
        locale: "en",
        messages,
        namespace: (typeof input === "string"
          ? input
          : input?.namespace) as never,
      }),
    setRequestLocale: () => {},
  };
});
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = (await import("../../../../messages/en.json")).default;
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace?: string) =>
      actual.createTranslator({
        locale: "en",
        messages,
        namespace: namespace as never,
      }),
  };
});

// The community slots are async placeholders that renderToStaticMarkup cannot
// render synchronously; this suite is about the page around them.
vi.mock("../_components/community/public-skill-overview", () => ({
  PublicSkillOverview: () => null,
}));
vi.mock("../_components/community/public-skill-report", () => ({
  PublicSkillReport: () => null,
}));
vi.mock("../_components/community/public-skill-reviews", () => ({
  PublicSkillReviews: () => null,
}));
vi.mock("../_components/community/public-skill-run-stats", () => ({
  PublicSkillRunStats: () => null,
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
      featured: false,
      version: "1.2.0",
      cliInstallable: true,
      stars: 0,
      repoPushedAt: null,
      repoArchived: false,
      claimed: false,
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
    params: Promise.resolve({ locale: "en", slug: "pdf-forms" }),
    searchParams: Promise.resolve(tab ? { tab } : {}),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  auth.isSignedIn = false;
  market.getPublicSkill.mockReset().mockResolvedValue(response());
  reviews.getPublicSkillReviews.mockReset().mockResolvedValue(null);
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
    // Workspaces that added it — the CLI reports nothing back.
    expect(html).toContain("Added to 1.2K workspaces");
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
    expect(html).not.toContain("Added to");
    expect(html).toContain("No license");
    expect(html).not.toContain("Verified");
  });

  it("marks a featured publisher's skill, apart from verified", async () => {
    expect(await render()).not.toContain("Featured");
    market.getPublicSkill.mockResolvedValue(
      response({}, { featured: true, verified: false }),
    );
    const html = await render();
    expect(html).toContain("Featured");
    expect(html).not.toContain(">Verified<");
    market.getPublicSkill.mockResolvedValue(
      response({}, { featured: true, verified: true }),
    );
    expect(await render()).toContain("Featured, Verified");
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

  it("offers the workspace, then the verified CLI, then the upstream installer", async () => {
    const html = await render("install");
    const workspace = html.indexOf("Add to a SourceWeft workspace");
    const cli = html.indexOf("Install on your own machine — recommended");
    const upstream = html.indexOf(
      "Upstream installer — not verified by SourceWeft",
    );
    expect(workspace).toBeGreaterThan(-1);
    expect(cli).toBeGreaterThan(workspace);
    expect(upstream).toBeGreaterThan(cli);
    expect(html).toContain("npx @sourceweft/cli skills install pdf-forms");
    expect(html).toContain("--agent claude-code, codex, cursor or universal");
    expect(html).toContain("verifies every file against the hashes");
    expect(html).toContain(
      `npx skills add https://github.com/anthropics/skills/tree/${SHA}/pdf`,
    );
  });

  it("offers no CLI command for a skill the CLI would refuse", async () => {
    market.getPublicSkill.mockResolvedValue(
      response({}, { cliInstallable: false }),
    );
    const html = await render("install");
    expect(html).not.toContain("@sourceweft/cli");
    expect(html).toContain("Upstream installer");
  });

  it("shows stars, the repository's last push, and the author's claim", async () => {
    market.getPublicSkill.mockResolvedValue(
      response(
        {},
        {
          stars: 4321,
          repoPushedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          repoArchived: true,
        },
      ),
    );
    let html = await render();
    expect(html).toContain("4.3K stars");
    expect(html).toContain("Repository updated 3 days ago");
    expect(html).toContain("Archived");
    expect(html).toContain(
      'href="/dashboard/skills/claim?repo=anthropics/skills"',
    );
    expect(html).not.toContain("Claimed by author");

    market.getPublicSkill.mockResolvedValue(response({}, { claimed: true }));
    html = await render();
    expect(html).toContain("Claimed by author");
    expect(html).not.toContain("/dashboard/skills/claim");
  });

  it("shows related skills from the same repository and the same category", async () => {
    const other = (slug: string) => ({
      ...response().skill,
      slug,
      displayName: `Other ${slug}`,
    });
    market.getPublicSkill.mockResolvedValue(
      response({
        related: {
          sameRepository: [other("docx")],
          sameCategory: [other("xlsx")],
        },
      }),
    );
    const html = await render();
    expect(html).toContain("More from anthropics/skills");
    expect(html).toContain('href="/skills/docx"');
    expect(html).toContain("More in Documents");
    expect(html).toContain('href="/skills/xlsx"');
  });

  it("says what each recent version changed", async () => {
    const base = response();
    market.getPublicSkill.mockResolvedValue(
      response({
        versions: [
          {
            ...base.versions[0]!,
            changes: {
              added: ["scripts/new.sh"],
              removed: [],
              modified: ["SKILL.md", "ref.md"],
              newScripts: ["scripts/new.sh"],
              newFlags: ["binary:executable"],
              compareUrl: `https://github.com/anthropics/skills/compare/${"a".repeat(40)}...${SHA}`,
            },
          },
          base.versions[1]!,
        ],
      }),
    );
    const html = await render("versions");
    expect(html).toContain("1 added · 2 modified");
    expect(html).toContain("New scripts: scripts/new.sh");
    expect(html).toContain("New scan flags: Ships an executable binary");
    expect(html).toContain(
      `href="https://github.com/anthropics/skills/compare/${"a".repeat(40)}...${SHA}"`,
    );
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
    // Nobody rated it: no rating is claimed.
    expect(code).not.toHaveProperty("aggregateRating");
  });

  it("adds the rating to the JSON-LD once someone rated it", async () => {
    reviews.getPublicSkillReviews.mockResolvedValue({
      items: [],
      nextCursor: null,
      summary: {
        count: 3,
        average: 4.333,
        distribution: { "1": 0, "2": 0, "3": 0, "4": 2, "5": 1 },
      },
    });
    const html = await render();
    const code = [
      ...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g),
    ]
      .map((match) => JSON.parse(match[1]!) as Record<string, unknown>)
      .find((block) => block["@type"] === "SoftwareSourceCode");
    expect(code?.aggregateRating).toMatchObject({
      "@type": "AggregateRating",
      ratingCount: 3,
      bestRating: 5,
      worstRating: 1,
    });
  });

  it("reads the page body in the page's locale", async () => {
    await render();
    expect(market.getPublicSkill).toHaveBeenCalledWith("pdf-forms", "en");
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
      params: Promise.resolve({ locale: "en", slug: "pdf-forms" }),
      searchParams: Promise.resolve({}),
    });
    expect(base.title).toBe("PDF Forms Agent Skill");
    expect(String(base.alternates?.canonical)).toMatch(/\/skills\/pdf-forms$/);
    expect(base.robots).toBeUndefined();

    const files = await generateMetadata({
      params: Promise.resolve({ locale: "en", slug: "pdf-forms" }),
      searchParams: Promise.resolve({ tab: "files" }),
    });
    expect(String(files.alternates?.canonical)).toMatch(/\/skills\/pdf-forms$/);
    expect(files.robots).toMatchObject({ index: false });
  });

  it("makes a locale its own page only where the skill has an overview in it", async () => {
    const overview = (locale: string) => ({
      summary: "s",
      whatItDoes: "w",
      whenToUse: "u",
      requirements: "r",
      locale,
      generatedAt: "2026-09-20T00:00:00.000Z",
    });
    // zh-CN has its own overview; zh-TW falls back to the English one.
    market.getPublicSkill.mockImplementation(async (_slug, locale) => ({
      ...response(),
      aiOverview: overview(locale === "zh-CN" ? "zh-CN" : "en"),
    }));

    const zhCN = await generateMetadata({
      params: Promise.resolve({ locale: "zh-CN", slug: "pdf-forms" }),
      searchParams: Promise.resolve({}),
    });
    expect(String(zhCN.alternates?.canonical)).toMatch(
      /\/zh-CN\/skills\/pdf-forms$/,
    );
    expect(Object.keys(zhCN.alternates?.languages ?? {}).sort()).toEqual([
      "en",
      "x-default",
      "zh-CN",
    ]);

    const zhTW = await generateMetadata({
      params: Promise.resolve({ locale: "zh-TW", slug: "pdf-forms" }),
      searchParams: Promise.resolve({}),
    });
    expect(String(zhTW.alternates?.canonical)).toMatch(/\/skills\/pdf-forms$/);
    expect(String(zhTW.alternates?.canonical)).not.toMatch(/zh-TW/);
  });
});
