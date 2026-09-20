import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { EnabledSkillDescriptor } from "./types";

const state = vi.hoisted(() => ({
  search: { items: [] as unknown[], total: 0 },
  installed: [] as unknown[],
  enabledSkills: [] as unknown[],
  resolveFails: false,
  // Set → `installSkill` answers with a background import instead of skills.
  submission: null as Record<string, unknown> | null,
  // What each poll of that import returns, in order; the last one repeats.
  polls: [] as Array<Record<string, unknown> | Error>,
  pollCount: 0,
  installCalls: [] as Array<Record<string, unknown>>,
  describeCalls: [] as Array<Record<string, unknown>>,
  failures: [] as Array<{ slug: string; message: string }>,
}));

vi.mock("./service", () => ({
  contentSkillsService: {
    installSkill: async (input: Record<string, unknown>) => {
      state.installCalls.push(input);
      return state.submission
        ? { skills: [], submission: state.submission }
        : { skills: state.installed };
    },
    describeSubmissionInstall: async (input: Record<string, unknown>) => {
      state.describeCalls.push(input);
      return { skills: state.installed, failures: state.failures };
    },
    searchCatalog: async () => ({ ...state.search, query: "q" }),
  },
}));
vi.mock("./registry/ingest/service", () => ({
  getSkillSubmission: async () => {
    const next =
      state.polls[Math.min(state.pollCount, state.polls.length - 1)];
    state.pollCount += 1;
    if (next instanceof Error) throw next;
    return { submission: next };
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
  state.submission = null;
  state.polls = [];
  state.pollCount = 0;
  state.installCalls = [];
  state.describeCalls = [];
  state.failures = [];
  vi.useRealTimers();
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

// --- GitHub sources: a background import, waited on briefly -----------------

afterEach(() => {
  vi.useRealTimers();
});

function submission(extra: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    workspaceId: "workspace",
    sourceInput: "o/r",
    status: "queued",
    stage: null,
    results: [],
    error: null,
    onComplete: { install: { installedVia: "agent" } },
    ...extra,
  };
}

/** Runs install_skill on a GitHub source under fake timers, to completion. */
async function importFromGitHub(
  input: { source?: string; skill?: string } = {},
  mountSkill?: MountSkill,
) {
  vi.useFakeTimers();
  const tools = buildSkillAgentTools({
    teamId: "team",
    workspaceId: "workspace",
    userId: "user",
    ...(mountSkill ? { mountSkill } : {}),
  });
  const tool = tools.find((item) => item.name === "install_skill")!;
  const started = Date.now();
  const pending = tool.invoke({ source: input.source ?? "o/r", ...input });
  await vi.runAllTimersAsync();
  return { result: String(await pending), elapsedMs: Date.now() - started };
}

test("a GitHub source is handed to the install path as the agent, with the skill it was narrowed to", async () => {
  state.submission = submission();
  state.polls = [submission({ status: "succeeded" })];
  await importFromGitHub({ source: "https://github.com/o/r", skill: "notes" });
  assert.deepEqual(state.installCalls, [
    {
      teamId: "team",
      workspaceId: "workspace",
      userId: "user",
      ref: { kind: "source", source: "https://github.com/o/r", skill: "notes" },
      installedVia: "agent",
    },
  ]);
});

test("an import that finishes in time reports the installed skills and mounts them", async () => {
  state.submission = submission();
  state.polls = [
    submission({ status: "running", stage: "download" }),
    submission({ status: "succeeded" }),
  ];
  const mounted: string[] = [];
  const { result, elapsedMs } = await importFromGitHub({}, (skill) => {
    mounted.push(skill.name);
    return { scriptsStageable: false };
  });
  assert.equal(state.pollCount, 2);
  assert.ok(elapsedMs < 15_000);
  assert.equal(state.describeCalls.length, 1);
  assert.equal(state.describeCalls[0]?.installedVia, "agent");
  assert.deepEqual(mounted, ["gh-o-r-notes"]);
  assert.match(result, /Installed and switched on 1 skill/);
  assert.match(result, /read now: \/skills\/gh-o-r-notes\/SKILL\.md/);
});

test("what was held for review or could not be switched on is reported next to what was installed", async () => {
  state.submission = submission();
  state.polls = [submission({ status: "succeeded" })];
  state.installed = [
    installedSkill("gh-o-r-notes"),
    { ...installedSkill("gh-o-r-held"), status: "queued", workspaceSkill: null },
  ];
  state.failures = [{ slug: "gh-o-r-big", message: "quota exceeded" }];
  const { result } = await importFromGitHub({}, mountOnly);
  assert.match(result, /Installed and switched on 1 skill/);
  assert.match(result, /1 skill\(s\) were indexed but held for review/);
  assert.match(result, /could not be switched on here[\s\S]*gh-o-r-big: quota exceeded/);
});

test("an import still running when the budget runs out is reported as in progress, within the budget", async () => {
  state.submission = submission();
  state.polls = [submission({ status: "running", stage: "analyze-scan" })];
  const { result, elapsedMs } = await importFromGitHub();
  assert.equal(
    result,
    "Import of o/r is in progress (stage: analyze-scan). It will be installed and switched on in this workspace automatically when it finishes; tell the user, and they can ask you to use it in a later message.",
  );
  assert.ok(elapsedMs <= 15_000, `waited ${elapsedMs}ms`);
  assert.ok(elapsedMs >= 14_000, `gave up after ${elapsedMs}ms`);
  assert.equal(state.describeCalls.length, 0);
});

test("a failed import reports the reason", async () => {
  state.submission = submission();
  state.polls = [
    submission({
      status: "failed",
      error: {
        code: "REGISTRY_SUBMISSION_NOT_SKILL",
        message: "No SKILL.md was found in o/r",
      },
    }),
  ];
  const { result } = await importFromGitHub();
  assert.equal(result, "Could not install 'o/r': No SKILL.md was found in o/r");
});

// `createSkillSubmission` hands back the caller's in-flight import of the same
// source instead of starting a second one.
test("a deduped in-flight import is reported as in progress, not as an error", async () => {
  state.submission = submission({ status: "running", stage: "download" });
  state.polls = [submission({ status: "running", stage: "discover" })];
  const { result } = await importFromGitHub();
  assert.match(result, /^Import of o\/r is in progress \(stage: discover\)\./);
  assert.match(result, /automatically when it finishes/);
  assert.doesNotMatch(result, /Could not install/);
});

test("a reused import that will not install here says so instead of promising it", async () => {
  // Started from the submit dialog: indexes only.
  state.submission = submission({ status: "running", stage: "download", onComplete: null });
  state.polls = [state.submission];
  const indexOnly = (await importFromGitHub()).result;
  assert.match(indexOnly, /is in progress \(stage: download\)/);
  assert.match(indexOnly, /call install_skill with the same source again/);
  assert.doesNotMatch(indexOnly, /automatically when it finishes/);

  // Started in another workspace: not pollable from here, so no waiting.
  state.submission = submission({ workspaceId: "elsewhere" });
  state.pollCount = 0;
  const { result, elapsedMs } = await importFromGitHub();
  assert.match(result, /is in progress \(stage: queued\)/);
  assert.doesNotMatch(result, /automatically when it finishes/);
  assert.equal(state.pollCount, 0);
  assert.equal(elapsedMs, 0);
});

test("a poll that fails ends the wait; the import is still reported as running", async () => {
  state.submission = submission();
  state.polls = [new Error("connection reset")];
  const { result } = await importFromGitHub();
  assert.match(result, /is in progress \(stage: queued\)/);
  assert.equal(state.pollCount, 1);
});
