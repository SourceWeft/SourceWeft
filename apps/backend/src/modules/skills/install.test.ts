import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

// `installSkill` is the one install path (catalog UI by id, agent by source).
// These tests pin what it may and may not hand to `upsertWorkspaceSkill`, which
// grants an entitlement as a side effect — so a wrong install is also a wrong
// grant.
const state = vi.hoisted(() => ({
  byName: [] as unknown[],
  byVersion: null as unknown,
  held: null as unknown,
  // Published registry rows the repo + path lookup finds (slug, storagePointer).
  published: [] as Array<{ slug: string; storagePointer: string }>,
  submission: null as unknown,
  upserts: [] as Array<Record<string, unknown>>,
  submissions: [] as Array<Record<string, unknown>>,
}));

vi.mock("./repository", () => ({
  // Like the real lookup: an exact slug wins over short-name matches.
  findInstallableSkillsByName: async (input: { name: string }) => {
    const rows = state.byName as Array<{ definition: { slug: string } }>;
    const exact = rows.filter((item) => item.definition.slug === input.name);
    return exact.length > 0 ? exact : rows;
  },
  findCatalogSkillVersionForWorkspace: async () => state.byVersion,
  mapWorkspaceSkill: (row: unknown) => row,
  upsertWorkspaceSkill: async (input: Record<string, unknown>) => {
    state.upserts.push(input);
    return { id: "ws-skill-1", enabled: input.enabled ?? true };
  },
}));
vi.mock("./registry/ingest/service", () => ({
  createSkillSubmission: async (input: Record<string, unknown>) => {
    state.submissions.push(input);
    return { submission: state.submission, created: true };
  },
}));
// The only inline query `installSkill` runs is the published repo + path
// lookup; everything else goes through the mocked repository.
vi.mock("@sourceweft/db", async (original) => {
  const query: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "where", "orderBy", "limit"]) {
    query[method] = () => query;
  }
  query.then = (
    resolve: (rows: unknown) => unknown,
    reject: (error: unknown) => unknown,
  ) => Promise.resolve(state.published).then(resolve, reject);
  return {
    ...(await original<typeof import("@sourceweft/db")>()),
    db: { select: () => query },
  };
});
// Skill blobs live in object storage, whose client is built at import time
// from config this file stubs down to what `installSkill` reads.
vi.mock("./storage", () => ({ readSkillBlob: vi.fn() }));
vi.mock("./registry/repository", () => ({
  getRegistrySkillBySlug: async () => state.held,
}));
vi.mock("../../shared/config", () => ({
  config: {
    auth: { webBaseUrl: "https://app.sourceweft.test" },
    market: { adminUserIds: [] },
  },
}));

const { contentSkillsService } = await import("./service");

const scope = { teamId: "team-1", workspaceId: "ws-1", userId: "user-1" };

function row(slug: string, extra: Record<string, unknown> = {}) {
  return {
    definition: {
      id: `def-${slug}`,
      slug,
      displayName: slug,
      description: `About ${slug}`,
      sourceType: "registry_github",
      ownerUserId: "user-1",
    },
    version: { id: `ver-${slug}`, manifestJson: {} },
    enabled: null,
    ...extra,
  };
}

function installBySource(source: string, skill?: string) {
  return contentSkillsService.installSkill({
    ...scope,
    ref: { kind: "source", source, ...(skill ? { skill } : {}) },
  });
}

beforeEach(() => {
  state.byName = [];
  state.byVersion = null;
  state.held = null;
  state.published = [];
  state.submission = { id: "sub-1", status: "queued", results: [] };
  state.upserts = [];
  state.submissions = [];
});

// The catalog lookup is visibility-scoped, so another submitter's `restricted`
// skill simply is not among its rows. The old slug path looked it up unscoped,
// installed it, and granted the workspace access.
test("a slug the workspace cannot see is not installed and nothing is granted", async () => {
  await assert.rejects(installBySource("gh-someone-else-private"), {
    code: "SKILL_NOT_FOUND",
  });
  assert.equal(state.upserts.length, 0);
  assert.equal(state.submissions.length, 0);
});

test("a visible slug installs switched on", async () => {
  state.byName = [row("gh-anthropics-skills-pdf")];
  const { skills } = await installBySource("gh-anthropics-skills-pdf");
  assert.equal(skills[0]?.status, "installed");
  assert.equal(state.upserts.length, 1);
  assert.equal(state.upserts[0]?.skillId, "def-gh-anthropics-skills-pdf");
  // `enabled` left to the repository default (true): installing enables.
  assert.equal(state.upserts[0]?.enabled, undefined);
});

test("a short name that matches several skills lists them instead of picking one", async () => {
  state.byName = [row("gh-anthropics-skills-pdf"), row("gh-openai-skills-pdf")];
  await assert.rejects(
    installBySource("pdf"),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "SKILL_NAME_AMBIGUOUS");
      assert.match(error.message, /gh-anthropics-skills-pdf/);
      assert.match(error.message, /gh-openai-skills-pdf/);
      return true;
    },
  );
  assert.equal(state.upserts.length, 0);
});

test("a link to our own skill page names a catalog entry", async () => {
  state.byName = [
    row("feynman", {
      definition: { ...row("feynman").definition, sourceType: "builtin" },
    }),
  ];
  await installBySource("https://app.sourceweft.test/dashboard/skills/feynman");
  assert.equal(state.upserts.length, 1);
  assert.equal(state.submissions.length, 0);
});

test("links to other sites are refused, not handed to the GitHub reader", async () => {
  await assert.rejects(
    installBySource("https://lobehub.com/skills/anthropics-skills-pptx"),
    { code: "SKILL_SOURCE_UNSUPPORTED" },
  );
  // Same path on a foreign origin must not be read as one of our pages.
  await assert.rejects(
    installBySource("https://evil.test/dashboard/skills/feynman"),
    { code: "SKILL_SOURCE_UNSUPPORTED" },
  );
  assert.equal(state.submissions.length, 0);
  assert.equal(state.upserts.length, 0);
});

test("a skill already on at this version is reported, not rewritten", async () => {
  state.byName = [
    row("feynman", {
      enabled: { id: "ws-1", enabled: true, skillVersionId: "ver-feynman" },
    }),
  ];
  const { skills } = await installBySource("feynman");
  assert.equal(skills[0]?.status, "already_installed");
  assert.equal(state.upserts.length, 0);
});

test("re-installing keeps the config already in place", async () => {
  state.byName = [row("feynman", { enabled: { configJson: { depth: 3 } } })];
  await installBySource("feynman");
  assert.deepEqual(state.upserts[0]?.configJson, { depth: 3 });
});

// Reading a repository can take minutes, so the install path only STARTS the
// import; the worker installs when it is done.
test("a repository not in the catalog becomes a submission with an on-complete install, and nothing is installed yet", async () => {
  const result = await installBySource("o/r", "a");
  assert.deepEqual(state.submissions, [
    { ...scope, source: "o/r", install: { skill: "a", installedVia: "user" } },
  ]);
  assert.deepEqual(result.skills, []);
  assert.equal(result.submission, state.submission);
  assert.equal(state.upserts.length, 0);

  state.submissions = [];
  await contentSkillsService.installSkill({
    ...scope,
    ref: { kind: "source", source: "https://github.com/o/r" },
    installedVia: "agent",
  });
  assert.deepEqual(state.submissions, [
    {
      ...scope,
      source: "https://github.com/o/r",
      install: { installedVia: "agent" },
    },
  ]);
});

test("a reference already published at that repo + path installs from the catalog, with no submission", async () => {
  state.published = [{ slug: "gh-o-r-a", storagePointer: "github:o/r@abc#skills/a" }];
  state.byName = [row("gh-o-r-a")];
  const result = await installBySource(
    "https://github.com/o/r/tree/main/skills/a",
  );
  assert.equal(state.submissions.length, 0);
  assert.equal(result.submission, undefined);
  assert.deepEqual(
    result.skills.map((item) => [item.slug, item.status]),
    [["gh-o-r-a", "installed"]],
  );
  assert.equal(state.upserts[0]?.skillId, "def-gh-o-r-a");
});

test("`skill` picks the published skill of that name out of the repository", async () => {
  state.published = [
    { slug: "gh-o-r-a", storagePointer: "github:o/r@abc#skills/a" },
    { slug: "gh-o-r-b", storagePointer: "github:o/r@abc#skills/b" },
  ];
  state.byName = [row("gh-o-r-a"), row("gh-o-r-b")];
  const { skills } = await installBySource("o/r", "b");
  assert.deepEqual(skills.map((item) => item.slug), ["gh-o-r-b"]);
  assert.equal(state.submissions.length, 0);
});

test("a published skill this workspace cannot see, or one pinned to another commit, is imported instead", async () => {
  // Published, but the visibility-scoped lookup does not return it.
  state.published = [{ slug: "gh-o-r-a", storagePointer: "github:o/r@abc#a" }];
  state.byName = [row("gh-someone-else-a")];
  await installBySource("https://github.com/o/r/tree/main/a");
  assert.equal(state.submissions.length, 1);
  assert.equal(state.upserts.length, 0);

  state.byName = [row("gh-o-r-a")];
  const sha = "0123456789abcdef0123456789abcdef01234567";
  await installBySource(`https://github.com/o/r/tree/${sha}/a`);
  assert.equal(state.submissions.length, 2);
  assert.equal(state.upserts.length, 0);
});

function finished(results: unknown[]) {
  return {
    id: "sub-1",
    status: "succeeded",
    sourceInput: "o/r",
    results,
  } as unknown as Parameters<
    typeof contentSkillsService.describeSubmissionInstall
  >[0]["submission"];
}
const result = (name: string, status: string, extra = {}) => ({
  sourcePath: `skills/${name}`,
  name,
  slug: `gh-o-r-${name}`,
  status,
  flags: [],
  diagnostics: [],
  ...extra,
});

test("a finished submission reports what the worker installed, what was held and what failed to switch on", async () => {
  state.byName = [
    row("gh-o-r-a", {
      enabled: { id: "ws-a", enabled: true, skillVersionId: "ver-gh-o-r-a" },
    }),
  ];
  state.held = row("gh-o-r-b");
  const outcome = await contentSkillsService.describeSubmissionInstall({
    ...scope,
    submission: finished([
      result("a", "indexed", { install: { status: "installed" } }),
      result("b", "queued", { install: { status: "skipped" } }),
      result("c", "indexed", {
        install: {
          status: "failed",
          error: { code: "X", message: "quota exceeded" },
        },
      }),
      { sourcePath: "skills/d", status: "failed", flags: [], diagnostics: [] },
    ]),
  });
  assert.deepEqual(
    outcome.skills.map((item) => [item.slug, item.status]),
    [
      // The worker's verdict, not "already installed" from asking again.
      ["gh-o-r-a", "installed"],
      ["gh-o-r-b", "queued"],
    ],
  );
  assert.equal(outcome.skills[0]?.workspaceSkill?.id, "ws-a");
  assert.deepEqual(outcome.failures, [
    { slug: "gh-o-r-c", message: "quota exceeded" },
  ]);
  assert.equal(state.upserts.length, 0);
});

test("a submission that carried no install is installed when it is described", async () => {
  state.byName = [row("gh-o-r-a")];
  const outcome = await contentSkillsService.describeSubmissionInstall({
    ...scope,
    submission: finished([result("a", "indexed"), result("b", "indexed")]),
    skill: "a",
    installedVia: "agent",
  });
  assert.deepEqual(
    outcome.skills.map((item) => [item.slug, item.status]),
    [["gh-o-r-a", "installed"]],
  );
  assert.equal(state.upserts.length, 1);
  assert.equal(state.upserts[0]?.installedVia, "agent");
});

test("an unknown `skill`, or nothing installable, is an error that names what the source ships", async () => {
  await assert.rejects(
    contentSkillsService.describeSubmissionInstall({
      ...scope,
      submission: finished([result("a", "indexed")]),
      skill: "zzz",
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "SKILL_NOT_FOUND");
      assert.match(error.message, /It ships: a/);
      return true;
    },
  );
  await assert.rejects(
    contentSkillsService.describeSubmissionInstall({
      ...scope,
      submission: finished([result("a", "indexed")]),
    }),
    { code: "SKILL_NOT_FOUND" },
  );
});

test("the catalog UI path installs by id through the same visibility check", async () => {
  await assert.rejects(
    contentSkillsService.installSkill({
      ...scope,
      ref: { kind: "version", skillId: "def-x", skillVersionId: "ver-x" },
    }),
    { code: "SKILL_NOT_FOUND" },
  );
  assert.equal(state.upserts.length, 0);

  state.byVersion = row("team-notes");
  const { skills } = await contentSkillsService.installSkill({
    ...scope,
    ref: {
      kind: "version",
      skillId: "def-team-notes",
      skillVersionId: "ver-team-notes",
    },
    configJson: { a: 1 },
  });
  assert.equal(skills[0]?.workspaceSkill?.id, "ws-skill-1");
  assert.deepEqual(state.upserts[0]?.configJson, { a: 1 });
});

// The agent acts AS the user, so `enabledBy` cannot tell the two apart.
test("an install records who performed it", async () => {
  state.byName = [row("feynman")];
  await installBySource("feynman");
  assert.equal(state.upserts[0]?.installedVia, "user");

  state.upserts = [];
  await contentSkillsService.installSkill({
    ...scope,
    ref: { kind: "source", source: "feynman" },
    installedVia: "agent",
  });
  assert.equal(state.upserts[0]?.installedVia, "agent");
});
