import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

/**
 * The stage runner against an in-memory submission row. GitHub, the archive
 * reader, analysis and the catalog write are faked; the REAL per-skill code in
 * `../submit` and the real triage guard run, so what reaches `results` is what
 * production would record.
 */

type Patch = Record<string, unknown>;
const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  patches: [] as Array<Record<string, unknown>>,
  superseded: false,
}));
const mocks = vi.hoisted(() => ({
  readArchive: vi.fn(),
  analyze: vi.fn(),
  getExisting: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("./repository", () => ({
  claimSubmission: vi.fn(async () => {
    if (!state.row || !["queued", "running"].includes(String(state.row.status)))
      return null;
    Object.assign(state.row, {
      status: "running",
      stage: null,
      stages: {},
      error: null,
      attempts: Number(state.row.attempts) + 1,
    });
    return { ...state.row };
  }),
  writeSubmissionProgress: vi.fn(async (_fence: unknown, patch: Patch) => {
    if (state.superseded) return false;
    // Snapshot: the runner mutates its `stages` object between writes.
    const snapshot = structuredClone(patch);
    state.patches.push(snapshot);
    Object.assign(state.row!, snapshot);
    return true;
  }),
}));
vi.mock("../read", async (original) => ({
  ...(await original<typeof import("../read")>()),
  readRegistrySkillsFromArchive: mocks.readArchive,
}));
vi.mock("../analyze", () => ({ analyzeRegistrySkill: mocks.analyze }));
vi.mock("../repository", () => ({
  getRegistrySkillForSubmission: mocks.getExisting,
  upsertRegistrySkillIndex: mocks.upsert,
}));
vi.mock("../../../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GitHubArchiveError } from "../../../market/parser/github-zip";
import { RegistrySubmissionError } from "../errors";
import { IngestSupersededError } from "./errors";
import { runIngestPipeline } from "./pipeline";
import { GITHUB_INGEST_STAGES, type IngestDeps } from "./stages";

const source = {
  owner: "acme",
  repo: "skills",
  subpath: "",
  repoUrl: "https://github.com/acme/skills",
  sourceUrl: "https://github.com/acme/skills",
  commitSha: "a".repeat(40),
  committedAt: "2026-02-01T10:00:00.000Z",
};

function analyzed(name: string, flags: string[] = []) {
  return {
    slug: `gh-acme-skills-${name}`,
    name,
    displayName: name,
    description: "d",
    repoSubpath: `skills/${name}`,
    capability: "prompt-only" as const,
    contentSha256: "h",
    scan: { reviewRequired: flags.length > 0, flags },
    fileManifest: [],
    allowedTools: [],
    diagnostics: [],
    findings: [],
  };
}

function deps(overrides: Partial<IngestDeps> = {}): IngestDeps {
  return {
    resolveSource: vi.fn(async () => source),
    downloadArchive: vi.fn(async () => Buffer.alloc(0)),
    installSkill: vi.fn(async () => ({ skills: [{ status: "installed" }] })),
    ...overrides,
  };
}

function seedRow(onComplete: unknown = null) {
  state.row = {
    id: "sub_1",
    teamId: "team_1",
    workspaceId: "ws_1",
    submittedBy: "user_1",
    sourceInput: "acme/skills",
    status: "queued",
    attempts: 0,
    onComplete,
  };
}

function skillsRead(names: string[]) {
  mocks.readArchive.mockResolvedValue({
    source,
    commitSha: source.commitSha,
    committedAt: source.committedAt,
    skills: names.map((name) => ({
      repoSubpath: `skills/${name}`,
      dirName: name,
      files: [],
    })),
  });
  for (const name of names) {
    mocks.analyze.mockReturnValueOnce(
      analyzed(name, name.startsWith("flagged") ? ["egress:pipe-to-shell"] : []),
    );
  }
}

const run = (
  overrides: Partial<Parameters<typeof runIngestPipeline>[0]> = {},
) =>
  runIngestPipeline({
    submissionId: "sub_1",
    signal: new AbortController().signal,
    willRetryTransient: true,
    deps: deps(),
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.analyze.mockReset();
  state.patches = [];
  state.superseded = false;
  seedRow();
  mocks.getExisting.mockResolvedValue(null);
  mocks.upsert.mockImplementation(async (input) => ({
    status: input.outcome,
    flags: input.manifestJson.registry.scan.flags,
    diagnostics: [],
    skillVersionId: `version-${input.slug}`,
    version: "a".repeat(12),
  }));
});

test("stages run in their declared order and each transition is persisted before the next begins", async () => {
  skillsRead(["writer"]);
  const outcome = await run();

  assert.deepEqual(outcome, {
    status: "succeeded",
    submissionId: "sub_1",
    skills: 1,
  });
  const names = GITHUB_INGEST_STAGES.map((stage) => stage.name);
  assert.deepEqual(names, [
    "resolve",
    "download",
    "discover",
    "analyze-scan",
    "triage-write",
    "on-complete",
  ]);
  // Two writes per stage — announced, then completed — and the closing write.
  const announced = state.patches
    .filter((patch) => typeof patch.stage === "string")
    .map((patch) => patch.stage);
  assert.deepEqual(announced, names);
  assert.equal(state.patches.length, names.length * 2 + 1);
  names.forEach((name, index) => {
    const announce = state.patches[index * 2]!.stages as Record<
      string,
      { status: string }
    >;
    assert.equal(announce[name]?.status, "running");
    // Nothing later than the running stage has been touched yet.
    assert.deepEqual(Object.keys(announce), names.slice(0, index + 1));
    const done = state.patches[index * 2 + 1]!.stages as typeof announce;
    assert.equal(done[name]?.status, "succeeded");
  });

  assert.equal(state.row!.status, "succeeded");
  assert.equal(state.row!.stage, null);
  assert.equal(state.row!.commitSha, source.commitSha);
  assert.deepEqual(
    state.row!.commitCommittedAt,
    new Date(source.committedAt),
  );
  assert.equal(
    (state.row!.results as Array<{ slug: string }>)[0]?.slug,
    "gh-acme-skills-writer",
  );
});

test("the GitHub helpers receive the job's abort signal", async () => {
  skillsRead(["writer"]);
  const injected = deps();
  const controller = new AbortController();
  await run({ deps: injected, signal: controller.signal });
  assert.equal(
    vi.mocked(injected.resolveSource).mock.calls[0]?.[1]?.signal,
    controller.signal,
  );
  assert.equal(
    vi.mocked(injected.downloadArchive).mock.calls[0]?.[1]?.signal,
    controller.signal,
  );
});

test("a deterministic failure marks the row failed with its code, even when retries remain, and writes no catalog rows", async () => {
  mocks.readArchive.mockRejectedValue(
    new RegistrySubmissionError("REGISTRY_SUBMISSION_NOT_SKILL", "No SKILL.md"),
  );
  await assert.rejects(run({ willRetryTransient: true }), RegistrySubmissionError);

  assert.equal(state.row!.status, "failed");
  assert.deepEqual(state.row!.error, {
    code: "REGISTRY_SUBMISSION_NOT_SKILL",
    message: "No SKILL.md",
  });
  assert.equal(state.row!.stage, "discover");
  const stages = state.row!.stages as Record<string, { status: string }>;
  assert.equal(stages.discover?.status, "failed");
  assert.equal("analyze-scan" in stages, false);
  assert.equal(mocks.upsert.mock.calls.length, 0);
});

test("archive errors are recorded under the submission taxonomy", async () => {
  await assert.rejects(
    run({
      deps: deps({
        downloadArchive: vi.fn(async () => {
          throw new GitHubArchiveError("ARCHIVE_TOO_LARGE", "too big");
        }),
      }),
    }),
  );
  assert.equal(state.row!.status, "failed");
  assert.deepEqual(state.row!.error, {
    code: "REGISTRY_SUBMISSION_TOO_LARGE",
    message: "too big",
  });
});

test("a transient failure goes back to queued while the queue will retry, and to failed once it will not", async () => {
  const flaky = () =>
    deps({
      resolveSource: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    });

  await assert.rejects(run({ deps: flaky(), willRetryTransient: true }));
  assert.equal(state.row!.status, "queued");
  assert.equal(state.row!.error, null);
  assert.equal(
    (state.row!.stages as Record<string, { status: string }>).resolve?.status,
    "failed",
  );

  // The retry claims the row again: progress restarts, attempts counts up.
  await assert.rejects(run({ deps: flaky(), willRetryTransient: false }));
  assert.equal(state.row!.attempts, 2);
  assert.equal(state.row!.status, "failed");
  assert.deepEqual(state.row!.error, {
    code: "REGISTRY_SUBMISSION_FAILED",
    message: "fetch failed",
  });
});

test("a fired deadline fails the run as a deadline, whatever the interrupted call threw", async () => {
  const controller = new AbortController();
  await assert.rejects(
    run({
      signal: controller.signal,
      willRetryTransient: true,
      deps: deps({
        downloadArchive: vi.fn(async () => {
          controller.abort(new DOMException("timed out", "TimeoutError"));
          throw new DOMException("timed out", "TimeoutError");
        }),
      }),
    }),
    (error) =>
      error instanceof RegistrySubmissionError &&
      error.code === "REGISTRY_SUBMISSION_DEADLINE",
  );
  assert.equal(state.row!.status, "failed");
  assert.equal(
    (state.row!.error as { code: string }).code,
    "REGISTRY_SUBMISSION_DEADLINE",
  );
});

test("a submission that indexes nothing fails but still shows every skill's diagnostics", async () => {
  skillsRead(["writer"]);
  mocks.getExisting.mockResolvedValue({
    ownerUserId: "someone-else",
    definitionStatus: "active",
    currentVersionStatus: "published",
  });
  await assert.rejects(run());

  assert.equal(state.row!.status, "failed");
  assert.equal(
    (state.row!.error as { code: string }).code,
    "REGISTRY_SUBMISSION_NOT_SKILL",
  );
  const results = state.row!.results as Array<{
    status: string;
    diagnostics: Array<{ code: string }>;
  }>;
  assert.equal(results[0]?.status, "failed");
  assert.equal(results[0]?.diagnostics[0]?.code, "REGISTRY_SUBMISSION_CONFLICT");
  assert.equal(mocks.upsert.mock.calls.length, 0);
});

test("one bad skill does not stop the others", async () => {
  mocks.readArchive.mockResolvedValue({
    source,
    commitSha: source.commitSha,
    skills: ["bad", "good"].map((name) => ({
      repoSubpath: `skills/${name}`,
      dirName: name,
      files: [],
    })),
  });
  mocks.analyze
    .mockImplementationOnce(() => {
      throw new RegistrySubmissionError(
        "REGISTRY_SUBMISSION_INVALID_SKILL",
        "bad frontmatter",
      );
    })
    .mockReturnValueOnce(analyzed("good"));

  await run();
  const results = state.row!.results as Array<{ status: string }>;
  assert.deepEqual(
    results.map((item) => item.status),
    ["failed", "indexed"],
  );
  assert.equal(state.row!.status, "succeeded");
});

test("a run that lost its claim stops without recording anything", async () => {
  skillsRead(["writer"]);
  state.superseded = true;
  await assert.rejects(run(), IngestSupersededError);
  assert.equal(state.patches.length, 0);
  assert.equal(mocks.upsert.mock.calls.length, 0);
});

test("an already-finished submission is skipped, not run again", async () => {
  state.row!.status = "succeeded";
  const injected = deps();
  assert.deepEqual(await run({ deps: injected }), {
    status: "skipped",
    submissionId: "sub_1",
  });
  assert.equal(vi.mocked(injected.resolveSource).mock.calls.length, 0);
});

test("on-complete installs only published skills, as the submitter, and records each outcome", async () => {
  seedRow({ install: { installedVia: "agent" } });
  skillsRead(["writer", "flagged-one", "reader"]);
  const injected = deps({
    installSkill: vi
      .fn()
      .mockResolvedValueOnce({ skills: [{ status: "installed" }] })
      .mockRejectedValueOnce(new Error("install boom")),
  });
  await run({ deps: injected });

  assert.deepEqual(
    vi.mocked(injected.installSkill).mock.calls.map((call) => call[0]),
    ["writer", "reader"].map((name) => ({
      teamId: "team_1",
      workspaceId: "ws_1",
      userId: "user_1",
      ref: { kind: "source", source: `gh-acme-skills-${name}` },
      installedVia: "agent",
    })),
  );
  const results = state.row!.results as Array<{
    name: string;
    install?: { status: string; error?: { message: string } };
  }>;
  assert.deepEqual(
    results.map((item) => [item.name, item.install?.status]),
    [
      ["writer", "installed"],
      // Held for review: a draft version cannot be installed.
      ["flagged-one", "skipped"],
      ["reader", "failed"],
    ],
  );
  assert.equal(results[2]?.install?.error?.message, "install boom");
  // An install failure is the skill's problem, not the submission's.
  assert.equal(state.row!.status, "succeeded");
});

test("the install filter narrows by author name or slug; the rest are indexed but left alone", async () => {
  seedRow({ install: { skill: "  Reader " } });
  skillsRead(["writer", "reader"]);
  const injected = deps();
  await run({ deps: injected });

  assert.equal(mocks.upsert.mock.calls.length, 2);
  assert.deepEqual(
    vi.mocked(injected.installSkill).mock.calls.map(
      (call) => call[0].ref.source,
    ),
    ["gh-acme-skills-reader"],
  );
  assert.equal(vi.mocked(injected.installSkill).mock.calls[0]?.[0].installedVia, "user");
  const results = state.row!.results as Array<{ install?: unknown }>;
  assert.equal(results[0]?.install, undefined);
});

test("an install filter that matches nothing fails the on-complete stage, not the submission", async () => {
  seedRow({ install: { skill: "nope" } });
  skillsRead(["writer"]);
  const injected = deps();
  await run({ deps: injected });

  assert.equal(vi.mocked(injected.installSkill).mock.calls.length, 0);
  assert.equal(state.row!.status, "succeeded");
  const stage = (
    state.row!.stages as Record<
      string,
      { status: string; error?: { code: string; message: string } }
    >
  )["on-complete"];
  assert.equal(stage?.status, "failed");
  assert.equal(stage?.error?.code, "SKILL_NOT_FOUND");
  assert.match(stage?.error?.message ?? "", /It ships: writer/);
});

test("without an install request on-complete does nothing", async () => {
  skillsRead(["writer"]);
  const injected = deps();
  await run({ deps: injected });
  assert.equal(vi.mocked(injected.installSkill).mock.calls.length, 0);
});
