import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { EnabledSkillDescriptor } from "./types";

const state = vi.hoisted(() => ({
  search: { items: [] as unknown[], total: 0 },
  installed: [] as unknown[],
  enabledSkills: [] as unknown[],
  resolveFails: false,
}));

vi.mock("./service", () => ({
  contentSkillsService: {
    installSkill: async () => ({ skills: state.installed }),
    searchCatalog: async () => ({ ...state.search, query: "q" }),
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

type MountSkill = (skill: EnabledSkillDescriptor) => {
  scriptsStageable: boolean;
};
const mountOnly: MountSkill = () => ({ scriptsStageable: false });

async function install(mountSkill?: MountSkill) {
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
  const result = await install((skill) => {
    mounted.push(skill.name);
    return { scriptsStageable: false };
  });
  // Only what was just installed — not every skill the workspace has enabled.
  assert.deepEqual(mounted, ["gh-o-r-notes"]);
  assert.match(result, /read now: \/skills\/gh-o-r-notes\/SKILL\.md/);
  assert.match(result, /usable in THIS turn/);
});

test("without a mount, or when mounting fails, the install still succeeds for the next turn", async () => {
  assert.match(await install(), /NEXT turn/);

  state.resolveFails = true;
  const result = await install(mountOnly);
  assert.match(result, /Installed and switched on 1 skill/);
  assert.match(result, /NEXT turn/);
  assert.doesNotMatch(result, /read now/);
});

test("scripts are reported as next-turn when the turn cannot stage them, even though the instructions are usable now", async () => {
  state.installed = [installedSkill("gh-o-r-notes", "executable")];
  const result = await install(mountOnly);
  assert.match(result, /usable in THIS turn/);
  assert.match(
    result,
    /scripts are staged into the sandbox when a turn starts/,
  );
  assert.doesNotMatch(result, /staged on first use/);
});

test("scripts the turn can stage are announced as runnable now, with the path and the fallback", async () => {
  state.installed = [installedSkill("gh-o-r-notes", "executable")];
  const result = await install(() => ({ scriptsStageable: true }));
  assert.match(result, /usable in THIS turn/);
  assert.match(result, /scripts are staged on first use this turn/);
  assert.match(result, /gh-o-r-notes \(\/skills\/gh-o-r-notes\/…\)/);
  // The turn-start sandbox rules may still forbid /skills in execute.
  assert.match(result, /replaces any earlier rule against \/skills/);
  assert.match(result, /SANDBOX_SKILL_STAGING_UNAVAILABLE/);
  assert.doesNotMatch(result, /when a turn starts/);
});

test("a prompt-only skill says nothing about scripts, and a failed mount keeps scripts next-turn", async () => {
  const promptOnly = await install(() => ({ scriptsStageable: true }));
  assert.doesNotMatch(promptOnly, /scripts/);

  state.installed = [installedSkill("gh-o-r-notes", "executable")];
  state.resolveFails = true;
  const unmounted = await install(() => ({ scriptsStageable: true }));
  assert.match(unmounted, /NEXT turn/);
  assert.match(unmounted, /when a turn starts/);
  assert.doesNotMatch(unmounted, /staged on first use/);
});

async function search() {
  const tools = buildSkillAgentTools({
    teamId: "team",
    workspaceId: "workspace",
    userId: "user",
  });
  const tool = tools.find((item) => item.name === "search_skills")!;
  return String(await tool.invoke({ query: "pdf" }));
}

// An empty result is where a model gives up or wanders off to the web.
test("an empty search says what to try next instead of just 'nothing'", async () => {
  state.search = { items: [], total: 0 };
  const result = await search();
  assert.match(result, /retry ONCE with a single short keyword/);
  assert.match(result, /pass it to install_skill/);
});

test("search results carry the signals a choice needs", async () => {
  const item = (slug: string, extra: Record<string, unknown>) => ({
    slug,
    displayName: slug,
    description: "d",
    sourceType: "registry_github",
    license: "MIT",
    flagged: false,
    verified: false,
    sourceUrl: null,
    installCount: 0,
    enabled: false,
    installable: true,
    ...extra,
  });
  state.search = {
    total: 40,
    items: [
      item("feynman", { sourceType: "builtin", installCount: 12 }),
      item("gh-o-r-pdf", { enabled: true }),
      item("gh-o-r-held", { installable: false }),
    ],
  };
  const result = await search();
  assert.match(result, /40 skills match .* the best 3/);
  assert.match(
    result,
    /1\. feynman .*\n.*built-in, first-party.*on in 12 workspace/,
  );
  assert.match(result, /gh-o-r-pdf[\s\S]*ALREADY installed and on here/);
  assert.match(result, /gh-o-r-held[\s\S]*HELD for review/);
});

test("re-installing something already on reports that nothing changed", async () => {
  state.installed = [
    { ...installedSkill("gh-o-r-notes"), status: "already_installed" },
  ];
  const result = await install(mountOnly);
  assert.match(result, /Already installed and on — nothing changed/);
});
