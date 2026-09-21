import assert from "node:assert/strict";
import test from "node:test";
import * as skillContracts from "../src/skills";
import {
  createSkillSubmissionRequestSchema,
  getSkillCatalogDetailResponseSchema,
  listSkillsCatalogQuerySchema,
  skillSubmissionSchema,
  skillManifestJsonSchema,
  workspaceInstalledSkillSchema,
} from "../src/skills";

function manifest(defaultEnabled?: boolean) {
  return {
    slug: "example-skill",
    displayName: "Example Skill",
    version: "1.0.0",
    description: "Example skill manifest.",
    visibility: "restricted" as const,
    categories: [],
    ...(defaultEnabled === undefined ? {} : { defaultEnabled }),
  };
}

test("skill manifest preserves an explicit default selection independently of visibility", () => {
  assert.equal(
    skillManifestJsonSchema.parse(manifest(true)).defaultEnabled,
    true,
  );
  assert.equal(
    skillManifestJsonSchema.parse(manifest(false)).defaultEnabled,
    false,
  );
  assert.equal(
    skillManifestJsonSchema.parse(manifest()).defaultEnabled,
    undefined,
  );
});

test("catalog query defaults to one page of 50 and refuses out-of-range paging", () => {
  // With nothing asked for: the whole catalog, in the recommended order.
  const unfiltered = {
    trust: "all",
    capability: "all",
    installed: "all",
    sort: "recommended",
  };
  assert.deepEqual(listSkillsCatalogQuerySchema.parse({}), {
    limit: 50,
    ...unfiltered,
  });
  assert.deepEqual(
    listSkillsCatalogQuerySchema.parse({ limit: "100", cursor: "abc", q: " pdf " }),
    { limit: 100, cursor: "abc", q: "pdf", ...unfiltered },
  );
  for (const limit of ["0", "101", "1.5", "many"]) {
    assert.equal(listSkillsCatalogQuerySchema.safeParse({ limit }).success, false);
  }
  assert.equal(listSkillsCatalogQuerySchema.safeParse({ cursor: "" }).success, false);
});

test("catalog query takes the market's filters and sort, and nothing it does not know", () => {
  assert.deepEqual(
    listSkillsCatalogQuerySchema.parse({
      category: " development ",
      trust: "verified",
      capability: "prompt-only",
      installed: "not_installed",
      sort: "popular",
    }),
    {
      limit: 50,
      category: "development",
      trust: "verified",
      capability: "prompt-only",
      installed: "not_installed",
      sort: "popular",
    },
  );
  for (const bad of [
    { sort: "trending" },
    { trust: "official" },
    { capability: "scripts" },
    { installed: "yes" },
    { category: "  " },
  ]) {
    assert.equal(listSkillsCatalogQuerySchema.safeParse(bad).success, false);
  }
});

test("a skill submission request takes a source and an optional install narrowing, nothing else", () => {
  assert.deepEqual(
    createSkillSubmissionRequestSchema.parse({
      source: "  owner/repo  ",
      install: { skill: "pdf" },
    }),
    { source: "owner/repo", install: { skill: "pdf" } },
  );
  assert.equal(
    createSkillSubmissionRequestSchema.safeParse({ source: "   " }).success,
    false,
  );
  // Who installs is decided server-side, never by the request body.
  assert.equal(
    createSkillSubmissionRequestSchema.safeParse({
      source: "owner/repo",
      install: { installedVia: "agent" },
    }).success,
    false,
  );
  assert.equal(
    createSkillSubmissionRequestSchema.safeParse({
      source: "owner/repo",
      target: "team",
    }).success,
    false,
  );
});

test("a skill submission carries per-stage progress and per-skill install outcomes", () => {
  const parsed = skillSubmissionSchema.parse({
    id: "sub_1",
    workspaceId: "ws_1",
    submittedBy: "user_1",
    sourceKind: "github",
    sourceInput: "owner/repo",
    repoOwner: "owner",
    repoName: "repo",
    ref: null,
    subpath: null,
    commitSha: null,
    commitCommittedAt: null,
    target: "workspace",
    status: "running",
    stage: "download",
    stages: {
      resolve: {
        status: "succeeded",
        startedAt: "2026-09-20T00:00:00.000Z",
        finishedAt: "2026-09-20T00:00:01.000Z",
      },
      download: { status: "running", startedAt: "2026-09-20T00:00:01.000Z" },
    },
    results: [
      {
        sourcePath: "skills/pdf",
        slug: "gh-owner-repo-pdf",
        name: "pdf",
        status: "queued",
        flags: ["egress:pipe-to-shell"],
        diagnostics: [],
        install: { status: "skipped" },
      },
    ],
    onComplete: { install: { skill: "pdf" } },
    error: null,
    attempts: 1,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:01.000Z",
    startedAt: "2026-09-20T00:00:00.000Z",
    finishedAt: null,
  });
  assert.deepEqual(Object.keys(parsed.stages), ["resolve", "download"]);
  assert.equal(parsed.results[0]?.install?.status, "skipped");
});

test("a skill detail may say its full text was withheld from this viewer", () => {
  // Only what the detail schema itself owns; `skill` has its own coverage.
  const documents = getSkillCatalogDetailResponseSchema.omit({ skill: true });
  const open = { readmeContent: "# R", readmePath: "README.md", skillContent: "# S" };
  assert.equal(documents.parse(open).contentRestricted, undefined);
  assert.deepEqual(
    documents.parse({
      readmeContent: null,
      readmePath: "README.md",
      skillContent: null,
      contentRestricted: true,
    }),
    {
      readmeContent: null,
      readmePath: "README.md",
      skillContent: null,
      contentRestricted: true,
    },
  );
});

test("an installed skill may say a newer version is current, and older answers still parse", () => {
  const installed = {
    workspaceSkillId: "ws-1",
    selectionId: "ws-1",
    catalogId: "skill-1:v1",
    sourceType: "registry_github" as const,
    skillId: "skill-1",
    skillVersionId: "v1",
    slug: "gh-acme-tools-example",
    name: "Example",
    version: "1.0.0",
    displayName: "Example",
    description: "Example installed skill.",
    visibility: "public" as const,
    categories: [],
    enabled: true,
    configJson: {},
    enabledBy: null,
    enabledAt: null,
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
  };
  // An API that predates the signal: absent, not an error and not `false`.
  const before = workspaceInstalledSkillSchema.parse(installed);
  assert.equal(before.updateAvailable, undefined);
  assert.equal(before.currentVersionId, undefined);

  const behind = workspaceInstalledSkillSchema.parse({
    ...installed,
    currentVersionId: "v2",
    updateAvailable: true,
  });
  assert.equal(behind.currentVersionId, "v2");
  assert.equal(behind.updateAvailable, true);

  // No published current version (the newest is still under review).
  const held = workspaceInstalledSkillSchema.parse({
    ...installed,
    currentVersionId: null,
    updateAvailable: false,
  });
  assert.equal(held.currentVersionId, null);
  assert.equal(held.updateAvailable, false);

  assert.equal(
    workspaceInstalledSkillSchema.safeParse({
      ...installed,
      updateAvailable: "yes",
    }).success,
    false,
  );
});

test("the synchronous submit request is gone; submissions are the only intake", () => {
  assert.equal("submitRegistrySkillRequestSchema" in skillContracts, false);
  assert.equal("createSkillSubmissionRequestSchema" in skillContracts, true);
});
