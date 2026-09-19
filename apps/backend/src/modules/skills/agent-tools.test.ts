import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { EnabledSkillDescriptor } from "./types";

const state = vi.hoisted(() => ({
  installed: [] as unknown[],
  enabledSkills: [] as unknown[],
  resolveFails: false,
}));

vi.mock("./service", () => ({
  contentSkillsService: {
    installSkill: async () => ({ skills: state.installed }),
  },
}));
vi.mock("./selection", () => ({
  resolveSelectedSkills: async () => {
    if (state.resolveFails) throw new Error("bundle unavailable");
    return state.enabledSkills;
  },
}));

const { buildSkillAgentTools } = await import("./agent-tools");

function installedSkill(slug: string, capability = "prompt-only") {
  return {
    slug,
    displayName: slug,
    description: `About ${slug}`,
    sourceType: "registry_github",
    capability,
    license: "MIT",
    flagged: false,
    sourceUrl: null,
    status: "installed",
    workspaceSkill: { id: `ws-${slug}` },
  };
}

function descriptor(slug: string): EnabledSkillDescriptor {
  return {
    workspaceSkillId: `ws-${slug}`,
    sourceType: "registry_github",
    name: slug,
    version: "1",
    description: `About ${slug}`,
    files: [],
  };
}

async function install(mountSkill?: (skill: EnabledSkillDescriptor) => void) {
  const tools = buildSkillAgentTools({
    teamId: "team",
    workspaceId: "workspace",
    userId: "user",
    ...(mountSkill ? { mountSkill } : {}),
  });
  const tool = tools.find((item) => item.name === "install_skill")!;
  return String(await tool.invoke({ source: "gh-o-r-notes" }));
}

beforeEach(() => {
  state.installed = [installedSkill("gh-o-r-notes")];
  state.enabledSkills = [
    descriptor("already-there"),
    descriptor("gh-o-r-notes"),
  ];
  state.resolveFails = false;
});

test("an installed skill is mounted into the running turn and the result says where to read it", async () => {
  const mounted: string[] = [];
  const result = await install((skill) => mounted.push(skill.name));
  // Only what was just installed — not every skill the workspace has enabled.
  assert.deepEqual(mounted, ["gh-o-r-notes"]);
  assert.match(result, /read now: \/skills\/gh-o-r-notes\/SKILL\.md/);
  assert.match(result, /usable in THIS turn/);
});

test("without a mount, or when mounting fails, the install still succeeds for the next turn", async () => {
  assert.match(await install(), /NEXT turn/);

  state.resolveFails = true;
  const result = await install(() => undefined);
  assert.match(result, /Installed and switched on 1 skill/);
  assert.match(result, /NEXT turn/);
  assert.doesNotMatch(result, /read now/);
});

test("scripts are reported as next-turn even when the instructions are usable now", async () => {
  state.installed = [installedSkill("gh-o-r-notes", "executable")];
  const result = await install(() => undefined);
  assert.match(result, /usable in THIS turn/);
  assert.match(
    result,
    /scripts are staged into the sandbox when a turn starts/,
  );
});
