import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  created: [] as string[],
  createError: null as unknown,
  builtinSync: [] as string[],
  syncErrors: new Map<string, unknown>(),
}));

vi.mock("./builtin", () => ({
  getBuiltinSkillBySlug: async (slug: string) =>
    slug === "feynman" ? { slug } : null,
  listBuiltinSkills: async () =>
    ["feynman", "ppt-deck"].map((slug) => ({ slug, manifestJson: {} })),
  validateBuiltinSkills: async () => undefined,
  loadBuiltinSkillBundle: async () => null,
}));
vi.mock("./repository", async () => {
  class BuiltinSkillSlugConflictError extends Error {
    slug: string;
    conflictingSourceType = "workspace_custom";
    constructor(slug: string) {
      super("conflict");
      this.slug = slug;
    }
  }
  return {
    BuiltinSkillSlugConflictError,
    createWorkspaceCustomSkillDraft: async (input: { name: string }) => {
      if (state.createError) throw state.createError;
      state.created.push(input.name);
      return { definition: { slug: input.name } };
    },
    syncBuiltinSkillMetadata: async (input: { slug: string }) => {
      const error = state.syncErrors.get(input.slug);
      if (error === "conflict")
        throw new BuiltinSkillSlugConflictError(input.slug);
      if (error) throw error;
      state.builtinSync.push(input.slug);
      return { slug: input.slug };
    },
  };
});

const { contentSkillsService } = await import("./service");

const base = {
  teamId: "team",
  workspaceId: "workspace",
  userId: "user",
  description: "d",
};

beforeEach(() => {
  state.created = [];
  state.createError = null;
  state.builtinSync = [];
  state.syncErrors = new Map();
});

// Slugs are global: `gh-…` belongs to the registry, and a builtin's name would
// shadow a skill we ship.
test("a custom skill cannot take a registry-namespace or builtin name", async () => {
  for (const name of ["gh-anthropics-skills-pdf", "feynman"]) {
    await assert.rejects(
      contentSkillsService.createWorkspaceCustomSkill({ ...base, name }),
      { code: "SKILL_NAME_RESERVED", statusCode: 409 },
    );
  }
  assert.deepEqual(state.created, []);
  await contentSkillsService.createWorkspaceCustomSkill({
    ...base,
    name: "team-notes",
  });
  assert.deepEqual(state.created, ["team-notes"]);
});

test("a name another workspace already holds is a 409, not a 500", async () => {
  // drizzle wraps the pg error, so the fields arrive on `cause`.
  state.createError = Object.assign(new Error("Failed query"), {
    cause: { code: "23505", constraint: "skill_definitions_slug_uq" },
  });
  await assert.rejects(
    contentSkillsService.createWorkspaceCustomSkill({ ...base, name: "pdf" }),
    { code: "SKILL_NAME_TAKEN", statusCode: 409 },
  );
  // Anything else is not ours to relabel.
  state.createError = new Error("connection refused");
  await assert.rejects(
    contentSkillsService.createWorkspaceCustomSkill({ ...base, name: "pdf" }),
    /connection refused/,
  );
});

// This runs at API boot: one squatted builtin name must not take the API down.
test("a builtin whose slug is taken is skipped; the rest still sync", async () => {
  state.syncErrors.set("feynman", "conflict");
  const result = await contentSkillsService.syncBuiltinCatalog();
  assert.deepEqual(result.skipped, ["feynman"]);
  assert.deepEqual(state.builtinSync, ["ppt-deck"]);
});

test("any other sync failure still fails the boot", async () => {
  state.syncErrors.set("feynman", new Error("database is down"));
  await assert.rejects(
    contentSkillsService.syncBuiltinCatalog(),
    /database is down/,
  );
});
