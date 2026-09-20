import assert from "node:assert/strict";
import test from "node:test";
import * as skillContracts from "../src/skills";
import {
  createSkillSubmissionRequestSchema,
  getSkillCatalogDetailResponseSchema,
  listSkillsCatalogQuerySchema,
  skillSubmissionSchema,
  skillManifestJsonSchema,
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
  assert.deepEqual(listSkillsCatalogQuerySchema.parse({}), { limit: 50 });
  assert.deepEqual(
    listSkillsCatalogQuerySchema.parse({ limit: "100", cursor: "abc", q: " pdf " }),
    { limit: 100, cursor: "abc", q: "pdf" },
  );
  for (const limit of ["0", "101", "1.5", "many"]) {
    assert.equal(listSkillsCatalogQuerySchema.safeParse({ limit }).success, false);
  }
  assert.equal(listSkillsCatalogQuerySchema.safeParse({ cursor: "" }).success, false);
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

test("the synchronous submit request is gone; submissions are the only intake", () => {
  assert.equal("submitRegistrySkillRequestSchema" in skillContracts, false);
  assert.equal("createSkillSubmissionRequestSchema" in skillContracts, true);
});
