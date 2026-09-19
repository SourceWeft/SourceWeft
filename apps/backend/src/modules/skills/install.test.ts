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
  submitted: null as unknown,
  upserts: [] as Array<Record<string, unknown>>,
  submits: [] as string[],
}));

vi.mock("./repository", () => ({
  findInstallableSkillsByName: async () => state.byName,
  findCatalogSkillVersionForWorkspace: async () => state.byVersion,
  mapWorkspaceSkill: (row: unknown) => row,
  upsertWorkspaceSkill: async (input: Record<string, unknown>) => {
    state.upserts.push(input);
    return { id: "ws-skill-1", enabled: input.enabled ?? true };
  },
}));
vi.mock("./registry/submit", () => ({
  submitRegistrySkillFromGitHub: async (input: { repoUrl: string }) => {
    state.submits.push(input.repoUrl);
    return state.submitted;
  },
}));
vi.mock("./registry/repository", () => ({
  getRegistrySkillBySlug: async () => state.held,
}));
vi.mock("../../shared/config", () => ({
  config: { auth: { webBaseUrl: "https://app.sourceweft.test" } },
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
  state.submitted = null;
  state.upserts = [];
  state.submits = [];
});

// The catalog lookup is visibility-scoped, so another submitter's `restricted`
// skill simply is not among its rows. The old slug path looked it up unscoped,
// installed it, and granted the workspace access.
test("a slug the workspace cannot see is not installed and nothing is granted", async () => {
  await assert.rejects(installBySource("gh-someone-else-private"), {
    code: "SKILL_NOT_FOUND",
  });
  assert.equal(state.upserts.length, 0);
  assert.equal(state.submits.length, 0);
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
  assert.equal(state.submits.length, 0);
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
  assert.equal(state.submits.length, 0);
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

test("a repository is submitted, then only its clean skills are installed", async () => {
  state.submitted = {
    status: "queued",
    skills: [
      {
        sourcePath: "skills/a",
        name: "a",
        slug: "gh-o-r-a",
        status: "indexed",
        flags: [],
        diagnostics: [],
      },
      {
        sourcePath: "skills/b",
        name: "b",
        slug: "gh-o-r-b",
        status: "queued",
        flags: ["x"],
        diagnostics: [],
      },
      { sourcePath: "skills/c", status: "failed", flags: [], diagnostics: [] },
    ],
  };
  state.byName = [row("gh-o-r-a")];
  state.held = row("gh-o-r-b");
  const { skills } = await installBySource("o/r");
  assert.deepEqual(state.submits, ["o/r"]);
  assert.deepEqual(
    skills.map((item) => [item.slug, item.status]),
    [
      ["gh-o-r-a", "installed"],
      ["gh-o-r-b", "queued"],
    ],
  );
  assert.equal(state.upserts.length, 1);
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
