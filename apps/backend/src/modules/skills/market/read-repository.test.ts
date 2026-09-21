import { skillCatalogQueryWords } from "./catalog-query";
import assert from "node:assert/strict";
import { test } from "vitest";
import type { SkillManifestJson } from "@sourceweft/db";
import {
  marketSkillFileSchema,
  marketSkillSummarySchema,
} from "@sourceweft/market-contracts";
import {
  mapMarketSkillSummary,
  marketSkillCommitSha,
  marketSkillFiles,
  marketSkillName,
  normalizeSha256,
  parseGithubStoragePointer,
  repositoryFromUrl,
  repositoryOwnerFromUrl,
} from "./read-repository";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function manifest(
  registry?: Partial<NonNullable<SkillManifestJson["registry"]>> | null,
  extra: Record<string, unknown> = {},
): SkillManifestJson {
  return {
    slug: "gh-anthropics-skills-pdf",
    displayName: "PDF",
    version: "0123456789ab",
    description: "Work with PDF files",
    visibility: "public",
    categories: ["self-styled"],
    ...(registry === null
      ? {}
      : {
          registry: {
            identifier: "gh:anthropics/skills/pdf",
            sourceUrl: `https://github.com/anthropics/skills/tree/${SHA}/pdf`,
            repoUrl: "https://github.com/anthropics/skills",
            submittedBy: "user-1",
            capability: "executable",
            scan: { reviewRequired: false, flags: [] },
            fileManifest: [],
            ...registry,
          },
        }),
    ...extra,
  } as SkillManifestJson;
}

// --- author ---

test("the author is the repository's owner, in whatever form the URL is written", () => {
  for (const [url, owner] of [
    ["https://github.com/anthropics/skills", "anthropics"],
    ["https://github.com/anthropics/skills/", "anthropics"],
    ["https://github.com/anthropics/skills.git", "anthropics"],
    ["http://github.com/Some-Org/repo.name", "Some-Org"],
    ["https://github.com/anthropics/skills/tree/main/pdf", "anthropics"],
    ["https://github.com/anthropics/skills?tab=readme#top", "anthropics"],
    ["  https://github.com/anthropics/skills  ", "anthropics"],
    ["git@github.com:anthropics/skills.git", "anthropics"],
    ["ssh://git@github.com/anthropics/skills.git", "anthropics"],
    ["https://gitlab.example.com/group/project", "group"],
  ] as const) {
    assert.equal(repositoryOwnerFromUrl(url), owner, url);
  }
  assert.deepEqual(repositoryFromUrl("git@github.com:anthropics/skills.git"), {
    owner: "anthropics",
    repo: "skills",
  });
});

test("a URL that does not name an owner and a repository has no author", () => {
  for (const url of [
    null,
    undefined,
    "",
    "   ",
    "not a url",
    "anthropics/skills",
    "https://github.com",
    "https://github.com/",
    "https://github.com/anthropics",
    "https://github.com/anthropics/.git",
    "https://github.com/%3Cscript%3E/skills",
    "https://github.com/an%2Fthropics/skills",
    "https://github.com/bad%zz/skills",
    "mailto:someone@example.com",
  ]) {
    assert.equal(repositoryOwnerFromUrl(url), null, String(url));
  }
});

// --- name ---

test("the name is what the slug ends in after gh-<owner>-<repo>-, dashes and all", () => {
  assert.equal(
    marketSkillName({ slug: "gh-anthropics-skills-pdf", manifest: manifest() }),
    "pdf",
  );
  assert.equal(
    marketSkillName({
      slug: "gh-some-org-repo-name-internal-comms",
      manifest: manifest({ repoUrl: "https://github.com/Some-Org/repo.name" }),
    }),
    "internal-comms",
  );
});

test("a manifest that records a name is believed over the slug", () => {
  assert.equal(
    marketSkillName({
      slug: "gh-anthropics-skills-pdf",
      manifest: manifest({}, { name: "pdf-tools" }),
    }),
    "pdf-tools",
  );
  assert.equal(
    marketSkillName({
      slug: "gh-anthropics-skills-pdf",
      manifest: manifest({}, { name: "  " }),
    }),
    "pdf",
  );
});

test("without a repository to strip, the name is the slug's last segment, or the slug", () => {
  assert.equal(
    marketSkillName({ slug: "team-meeting-notes", manifest: manifest(null) }),
    "notes",
  );
  assert.equal(
    marketSkillName({
      slug: "gh-other-place-pdf",
      manifest: manifest({ repoUrl: "nonsense" }),
    }),
    "pdf",
  );
  assert.equal(
    marketSkillName({ slug: "standalone", manifest: manifest(null) }),
    "standalone",
  );
  // The repository alone: no name followed it, so nothing is stripped.
  assert.equal(
    marketSkillName({ slug: "gh-anthropics-skills", manifest: manifest() }),
    "skills",
  );
});

// --- storage pointer ---

test("a storage pointer gives the commit and the skill's directory", () => {
  assert.deepEqual(
    parseGithubStoragePointer(
      `github:anthropics/skills@${SHA}#document-skills/pdf`,
    ),
    {
      owner: "anthropics",
      repo: "skills",
      commitSha: SHA,
      repoSubpath: "document-skills/pdf",
    },
  );
  // A skill at the repository root: no subpath, written either way.
  for (const pointer of [
    `github:anthropics/skills@${SHA}`,
    `github:anthropics/skills@${SHA}#`,
  ]) {
    assert.equal(parseGithubStoragePointer(pointer)?.repoSubpath, "", pointer);
  }
  assert.equal(
    parseGithubStoragePointer(
      `github:Some-Org/repo.name@${SHA.toUpperCase()}#/a/b/`,
    )?.commitSha,
    SHA,
  );
  assert.equal(
    parseGithubStoragePointer(`github:Some-Org/repo.name@${SHA}#/a/b/`)
      ?.repoSubpath,
    "a/b",
  );
});

test("anything that is not a github pointer parses to null", () => {
  for (const pointer of [
    null,
    undefined,
    "",
    "builtin:pdf",
    "object:whatever",
    "github:anthropics/skills@main#pdf",
    `github:anthropics/skills@${SHA.slice(0, 39)}#pdf`,
    `github:anthropics@${SHA}#pdf`,
    `github:anthropics/skills/extra@${SHA}#pdf`,
    `gitlab:anthropics/skills@${SHA}#pdf`,
    `github:anthropics/skills@${SHA}#../elsewhere`,
    `github:anthropics/skills@${SHA}#pdf/../../elsewhere`,
  ]) {
    assert.equal(parseGithubStoragePointer(pointer), null, String(pointer));
  }
});

test("the commit is the manifest's where it records one, else the pointer's", () => {
  assert.equal(
    marketSkillCommitSha({
      storagePointer: `github:anthropics/skills@${SHA}#pdf`,
      manifestJson: manifest(),
    }),
    SHA,
  );
  const recorded = "f".repeat(40);
  assert.equal(
    marketSkillCommitSha({
      storagePointer: `github:anthropics/skills@${SHA}#pdf`,
      manifestJson: manifest({ commitSha: recorded.toUpperCase() } as never),
    }),
    recorded,
  );
  assert.equal(
    marketSkillCommitSha({
      storagePointer: "object:whatever",
      manifestJson: manifest({ commitSha: "main" } as never),
    }),
    null,
  );
});

// --- files ---

const HASH = "0123456789abcdef".repeat(4);

test("a stored sha256 is normalised, and what is not one is not invented", () => {
  assert.equal(normalizeSha256(HASH), HASH);
  assert.equal(normalizeSha256(HASH.toUpperCase()), HASH);
  assert.equal(normalizeSha256(`sha256:${HASH}`), HASH);
  assert.equal(normalizeSha256(` SHA-256:${HASH.toUpperCase()} `), HASH);
  for (const value of [
    null,
    undefined,
    "",
    "hash",
    HASH.slice(1),
    `${HASH}0`,
    `md5:${HASH}`,
  ]) {
    assert.equal(normalizeSha256(value), null, String(value));
  }
});

test("the file manifest is every row, metadata only, with a usable hash", () => {
  const rows = [
    {
      path: "SKILL.md",
      sizeBytes: 10,
      mimeType: "text/markdown",
      contentHash: `sha256:${HASH.toUpperCase()}`,
    },
    {
      path: "bin/tool",
      sizeBytes: 9000,
      mimeType: "application/octet-stream",
      contentHash: "not-a-hash",
    },
    {
      path: "scripts/run.py",
      sizeBytes: 30,
      mimeType: "text/x-python",
      contentHash: "also-not",
      contentText: "secret",
      objectKey: "k",
    },
  ];
  const other = "a".repeat(64);
  const files = marketSkillFiles(rows, [
    { path: "bin/tool", sha256: other, sizeBytes: 9000, role: "asset" },
  ]);
  assert.deepEqual(files, [
    {
      path: "SKILL.md",
      sizeBytes: 10,
      mimeType: "text/markdown",
      contentHash: HASH,
    },
    // The row's hash is unusable; the manifest's for the same path is not.
    {
      path: "bin/tool",
      sizeBytes: 9000,
      mimeType: "application/octet-stream",
      contentHash: other,
    },
    // Nothing usable anywhere: it goes out as stored, for the contract to refuse.
    {
      path: "scripts/run.py",
      sizeBytes: 30,
      mimeType: "text/x-python",
      contentHash: "also-not",
    },
  ]);
  assert.ok(marketSkillFileSchema.safeParse(files[0]).success);
  assert.ok(!marketSkillFileSchema.safeParse(files[2]).success);
});

test("a version with no file rows lists its manifest, by path", () => {
  assert.deepEqual(
    marketSkillFiles(
      [],
      [
        {
          path: "b.txt",
          sha256: HASH.toUpperCase(),
          sizeBytes: 2,
          role: "asset",
        },
        {
          path: "SKILL.md",
          sha256: HASH,
          sizeBytes: 1,
          role: "model-readable",
        },
      ],
    ),
    [
      { path: "SKILL.md", sizeBytes: 1, mimeType: null, contentHash: HASH },
      { path: "b.txt", sizeBytes: 2, mimeType: null, contentHash: HASH },
    ],
  );
});

// --- query ---

test("a query is split into its distinct lowercase words, at most eight", () => {
  assert.deepEqual(skillCatalogQueryWords("  PDF, form;pdf　填写 "), [
    "pdf",
    "form",
    "填写",
  ]);
  assert.deepEqual(skillCatalogQueryWords("100% a_b"), ["100%", "a_b"]);
  assert.deepEqual(skillCatalogQueryWords(" , "), []);
  assert.equal(skillCatalogQueryWords("a b c d e f g h i j").length, 8);
});

// --- summary ---

const definition = {
  id: "skill-1",
  slug: "gh-anthropics-skills-pdf",
  verified: true,
  installCount: 7,
  listedAt: new Date("2026-09-01T00:00:00.000Z"),
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
};

test("a summary carries the market's facts, not the author's own claims", () => {
  const summary = mapMarketSkillSummary(
    {
      definition,
      version: {
        version: "0123456789ab",
        publishedAt: new Date("2026-09-02T00:00:00.000Z"),
        manifestJson: manifest({ license: "MIT" }, { verified: false }),
      },
    },
    ["documents-office"],
  );
  assert.deepEqual(summary, {
    slug: "gh-anthropics-skills-pdf",
    name: "pdf",
    displayName: "PDF",
    description: "Work with PDF files",
    // No logo of its own, so its publisher's avatar stands in.
    logo: {
      url: "https://github.com/anthropics.png?size=128",
      source: "publisher",
    },
    // The market's filing, not the manifest's `self-styled`.
    categories: ["documents-office"],
    verified: true,
    capability: "executable",
    license: "MIT",
    author: "anthropics",
    repoUrl: "https://github.com/anthropics/skills",
    sourceUrl: `https://github.com/anthropics/skills/tree/${SHA}/pdf`,
    installCount: 7,
    listedAt: "2026-09-01T00:00:00.000Z",
    version: "0123456789ab",
    updatedAt: "2026-09-02T00:00:00.000Z",
    cliInstallable: true,
    // Nothing read from GitHub yet, and nobody claimed it.
    stars: 0,
    repoPushedAt: null,
    repoArchived: false,
    claimed: false,
  });
  assert.ok(marketSkillSummarySchema.safeParse(summary).success);
});

test("a summary carries the repository's GitHub facts and whether it was claimed", () => {
  const summary = mapMarketSkillSummary(
    {
      definition: {
        ...definition,
        repoStars: 4200,
        claimedAt: new Date("2026-09-20T00:00:00.000Z"),
      },
      version: {
        version: "0123456789ab",
        publishedAt: null,
        manifestJson: manifest(),
      },
      repository: {
        pushedAt: new Date("2026-09-19T08:00:00.000Z"),
        archived: true,
      },
    },
    [],
  );
  assert.equal(summary.stars, 4200);
  assert.equal(summary.repoPushedAt, "2026-09-19T08:00:00.000Z");
  assert.equal(summary.repoArchived, true);
  assert.equal(summary.claimed, true);
});

test("the CLI command is offered only for a name the CLI will install", () => {
  const of = (slug: string, name?: string) =>
    mapMarketSkillSummary(
      {
        definition: { ...definition, slug },
        version: {
          version: "1",
          publishedAt: null,
          manifestJson: manifest({}, name ? { name } : {}),
        },
      },
      [],
    ).cliInstallable;
  assert.equal(of("gh-anthropics-skills-pdf"), true);
  assert.equal(of("gh-anthropics-skills-x", "My Skill"), false);
  assert.equal(of("gh-anthropics-skills-x", "../escape"), false);
  assert.equal(of("gh-anthropics-skills-x", "docx-tools"), true);
});

test("a public skill with no registry block and no listing date still fits the contract", () => {
  const summary = mapMarketSkillSummary(
    {
      definition: { ...definition, listedAt: null, verified: false },
      version: {
        version: "1.0.0",
        publishedAt: null,
        manifestJson: manifest(null),
      },
    },
    [],
  );
  assert.equal(summary.listedAt, "2026-08-01T00:00:00.000Z");
  assert.equal(summary.updatedAt, null);
  for (const field of [
    "capability",
    "license",
    "author",
    "repoUrl",
    "sourceUrl",
  ] as const) {
    assert.equal(summary[field], null, field);
  }
  assert.ok(marketSkillSummarySchema.safeParse(summary).success);
});
