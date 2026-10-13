import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  findCatalogSkillVersionForWorkspace: vi.fn(),
  upsertWorkspaceSkill: vi.fn(),
}));

vi.mock("../../shared/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: mocks.info,
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./repository")>()),
  findCatalogSkillVersionForWorkspace: mocks.findCatalogSkillVersionForWorkspace,
  upsertWorkspaceSkill: mocks.upsertWorkspaceSkill,
}));

import { contentSkillsService } from "./service";

const TEAM_ID = "team_0199cd4f7b1e7c3a9f0e";
const WORKSPACE_ID = "workspace_0199cd4f7b1e7c3a";
const USER_ID = "user_0199cd4f7b1e7c3a9f0e";

function catalogRow(input: { enabled?: boolean } = {}) {
  return {
    definition: {
      id: "skill_1",
      slug: "pdf-tools",
      displayName: "PDF Tools",
      description: "Work with PDF files.",
      sourceType: "registry",
    },
    version: {
      id: "ver_1",
      manifestJson: { registry: { capability: "prompt-only", sourceUrl: null } },
    },
    enabled: input.enabled
      ? {
          id: "ws_skill_1",
          teamId: TEAM_ID,
          workspaceId: WORKSPACE_ID,
          skillId: "skill_1",
          skillVersionId: "ver_1",
          enabled: true,
          configJson: {},
          enabledBy: USER_ID,
          enabledAt: new Date(0),
          installedVia: "user",
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }
      : null,
  };
}

const WORKSPACE_SKILL = { id: "ws_skill_1", enabled: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.upsertWorkspaceSkill.mockResolvedValue(WORKSPACE_SKILL);
});

test("installing a catalog skill logs skill.installed with truncated ids", async () => {
  mocks.findCatalogSkillVersionForWorkspace.mockResolvedValue(catalogRow());

  const result = await contentSkillsService.installSkill({
    teamId: TEAM_ID,
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    ref: { kind: "version", skillId: "skill_1", skillVersionId: "ver_1" },
    installedVia: "agent",
  });

  assert.equal(result.skills[0]?.status, "installed");
  const installed = mocks.info.mock.calls.filter(
    (call) => call[0] === "skill.installed",
  );
  assert.equal(installed.length, 1);
  const fields = installed[0]?.[1] as Record<string, unknown>;
  assert.deepEqual(fields, {
    teamId: "team_019",
    workspaceId: "workspac",
    slug: "pdf-tools",
    installedVia: "agent",
  });
  const serialized = JSON.stringify(fields);
  for (const full of [TEAM_ID, WORKSPACE_ID, USER_ID]) {
    assert.ok(!serialized.includes(full), `full id leaked: ${full}`);
  }
});

test("a skill that is already installed at this version logs nothing", async () => {
  mocks.findCatalogSkillVersionForWorkspace.mockResolvedValue(
    catalogRow({ enabled: true }),
  );

  const result = await contentSkillsService.installSkill({
    teamId: TEAM_ID,
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    ref: { kind: "version", skillId: "skill_1", skillVersionId: "ver_1" },
  });

  assert.equal(result.skills[0]?.status, "already_installed");
  assert.equal(mocks.upsertWorkspaceSkill.mock.calls.length, 0);
  assert.equal(
    mocks.info.mock.calls.some((call) => call[0] === "skill.installed"),
    false,
  );
});
