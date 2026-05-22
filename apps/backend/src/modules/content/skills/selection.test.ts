import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveSkillIdsWithSlashCommand } from "./selection";

test("resolveSkillIdsWithSlashCommand adds enabled skill id from slash activation", async () => {
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

test("resolveSkillIdsWithSlashCommand adds enabled skill id from slash subcommand", async () => {
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

  assert.deepEqual(skillIds, ["existing-skill", "enabled-feynman"]);
});

test("resolveSkillIdsWithSlashCommand leaves ids unchanged when skill is not enabled", async () => {
  const skillIds = await resolveSkillIdsWithSlashCommand({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: [],
    commandName: "/feynman",
    findSkillBySlug: async () => null,
  });

  assert.deepEqual(skillIds, []);
});
