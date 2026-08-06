import assert from "node:assert/strict";
import { test } from "vitest";
import { ContentError } from "../content/errors";
import {
  builtinSkillSelectionId,
  resolveSelectedSkills,
  resolveSkillIdsWithSlashCommand,
} from "./selection";
import type { WorkspaceSkillRecord } from "./types";

const emptyWorkspaceSkillDependencies = {
  listEnabledWorkspaceSkills: async () => [],
  listWorkspaceSkillsByIds: async () => [],
};

function workspaceSkill(
  overrides: Partial<WorkspaceSkillRecord> = {},
): WorkspaceSkillRecord {
  return {
    id: "workspace-skill-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillId: "skill-1",
    skillVersionId: "version-1",
    enabled: true,
    configJson: {},
    enabledBy: null,
    enabledAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

test("resolveSkillIdsWithSlashCommand resolves a managed builtin via the workspace install path", async () => {
  // feynman is a `managed` builtin (opt-in): a slash activation must resolve
  // through the install-checked workspace path, not the always-on builtin id.
  const skillIds = await resolveSkillIdsWithSlashCommand({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: [],
    commandName: "/feynman",
    findSkillBySlug: async (input) => ({
      id: `enabled-${input.slug}`,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      skillId: "skill-1",
      skillVersionId: "version-1",
      enabled: true,
      configJson: {},
      enabledBy: null,
      enabledAt: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }),
  });

  assert.deepEqual(skillIds, ["enabled-feynman"]);
});

test("resolveSkillIdsWithSlashCommand adds builtin id for an always-on builtin", async () => {
  // ppt-deck is a non-managed (always-on) builtin, so its slash activation
  // resolves directly to the builtin selection id without an install lookup.
  const skillIds = await resolveSkillIdsWithSlashCommand({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: [],
    commandName: "/ppt-deck",
    findSkillBySlug: async () => {
      throw new Error("always-on builtin must not hit the workspace path");
    },
  });

  assert.deepEqual(skillIds, ["builtin:ppt-deck"]);
});

test("resolveSkillIdsWithSlashCommand ignores slash subcommands", async () => {
  const skillIds = await resolveSkillIdsWithSlashCommand({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: ["existing-skill"],
    commandName: "/feynman:explain",
    findSkillBySlug: async (input) => ({
      id: `enabled-${input.slug}`,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      skillId: "skill-1",
      skillVersionId: "version-1",
      enabled: true,
      configJson: {},
      enabledBy: null,
      enabledAt: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }),
  });

  assert.deepEqual(skillIds, ["existing-skill"]);
});

test("resolveSkillIdsWithSlashCommand leaves ids unchanged when workspace skill is not enabled", async () => {
  const skillIds = await resolveSkillIdsWithSlashCommand({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: [],
    commandName: "/custom-review",
    findSkillBySlug: async () => null,
  });

  assert.deepEqual(skillIds, []);
});

test("resolveSelectedSkills allows builtin runtime ids without workspace install records", async () => {
  const skills = await resolveSelectedSkills({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: [builtinSkillSelectionId("ppt-deck")],
    ...emptyWorkspaceSkillDependencies,
  });

  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.workspaceSkillId, "builtin:ppt-deck");
  assert.equal(skills[0]?.selectionId, "builtin:ppt-deck");
  assert.equal(skills[0]?.sourceType, "builtin");
  assert.equal(skills[0]?.name, "ppt-deck");
});

test("resolveSelectedSkills allows public builtin runtime ids from chat options", async () => {
  const skills = await resolveSelectedSkills({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: [builtinSkillSelectionId("feynman")],
    ...emptyWorkspaceSkillDependencies,
  });

  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.workspaceSkillId, "builtin:feynman");
  assert.equal(skills[0]?.sourceType, "builtin");
  assert.equal(skills[0]?.name, "feynman");
});

test("resolveSelectedSkills includes Hub-enabled workspace skills without request skill ids", async () => {
  const record = workspaceSkill();
  const skills = await resolveSelectedSkills({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: [],
    listEnabledWorkspaceSkills: async () => [record],
    listWorkspaceSkillsByIds: async () => [],
    loadWorkspaceSkillVersion: async () => ({
      definition: {
        id: record.skillId,
        teamId: "team-1",
        workspaceId: "workspace-1",
        sourceType: "workspace_custom",
        slug: "custom-review",
        displayName: "Custom Review",
        description: "Review custom material.",
        visibility: "workspace",
        status: "active",
        ownerUserId: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      version: {
        id: record.skillVersionId,
        skillId: record.skillId,
        version: "1.0.0",
        status: "published",
        storageType: "db_text",
        storagePointer: "db://version-1",
        isCurrent: true,
        contentHash: "hash",
        manifestJson: {
          slug: "custom-review",
          displayName: "Custom Review",
          version: "1.0.0",
          description: "Review custom material.",
          visibility: "workspace",
          categories: [],
        },
        createdBy: "user-1",
        publishedAt: new Date(0),
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      files: [
        {
          path: "SKILL.md",
          contentText: "# Custom Review",
          mimeType: "text/markdown",
          sizeBytes: 15,
          contentHash: "hash-file",
        },
      ],
    }),
  });

  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.workspaceSkillId, record.id);
  assert.equal(skills[0]?.sourceType, "workspace_custom");
  assert.equal(skills[0]?.name, "custom-review");
});

test("resolveSelectedSkills ignores disabled workspace skills unless explicitly selected", async () => {
  const skills = await resolveSelectedSkills({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: [],
    listEnabledWorkspaceSkills: async () => [],
    listWorkspaceSkillsByIds: async () => [],
  });

  assert.deepEqual(skills, []);
});

test("resolveSelectedSkills rejects explicitly selected disabled workspace skills", async () => {
  const record = workspaceSkill({ enabled: false });
  await assert.rejects(
    () =>
      resolveSelectedSkills({
        teamId: "team-1",
        workspaceId: "workspace-1",
        skillIds: [record.id],
        listEnabledWorkspaceSkills: async () => [],
        listWorkspaceSkillsByIds: async () => [record],
      }),
    (error) =>
      error instanceof ContentError && error.code === "SKILL_DISABLED",
  );
});
