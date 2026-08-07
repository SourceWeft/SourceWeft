import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

/**
 * Orchestration of read → analyze → guard → index (skill-registry-index.md §3).
 * Read/analyze/repository are mocked; the REAL guard runs so triage
 * (clean→indexed, flagged/sticky/ownership→queued/throw) is exercised end-to-end.
 */

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  analyze: vi.fn(),
  getExisting: vi.fn(),
  upsert: vi.fn(),
  cleanup: vi.fn(),
}));

vi.mock("./read", () => ({ readRegistrySkillsFromGitHub: mocks.read }));
vi.mock("./analyze", () => ({ analyzeRegistrySkill: mocks.analyze }));
vi.mock("./repository", () => ({
  getRegistrySkillForSubmission: mocks.getExisting,
  upsertRegistrySkillIndex: mocks.upsert,
}));
vi.mock("../../market/parser/github", () => ({
  cleanupGitHubRepository: mocks.cleanup,
  prepareGitHubRepository: vi.fn(),
}));
vi.mock("../../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import { RegistrySubmissionError } from "./errors";
import { submitRegistrySkillFromGitHub } from "./submit";

function readResult(skillCount = 1) {
  return {
    source: {
      owner: "acme",
      repo: "skills",
      repoUrl: "https://github.com/acme/skills",
    },
    commitSha: "a".repeat(40),
    skills: Array.from({ length: skillCount }, (_, i) => ({
      repoSubpath: `skills/s${i}`,
      dirName: `s${i}`,
      files: [],
    })),
  };
}

function analyzed(overrides: Record<string, unknown> = {}) {
  return {
    slug: "gh-acme-skills",
    name: "writer",
    displayName: "Writer",
    description: "d",
    repoSubpath: "skills/writer",
    capability: "prompt-only" as const,
    license: "MIT",
    licenseTier: "permissive" as const,
    contentSha256: "h",
    scan: { reviewRequired: false, flags: [] as string[] },
    fileManifest: [
      { path: "SKILL.md", sha256: "h", sizeBytes: 1, role: "model-readable" as const },
    ],
    allowedTools: [] as string[],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getExisting.mockResolvedValue(null);
  mocks.upsert.mockResolvedValue({ status: "indexed" });
});

test("a clean, permissive, new skill indexes and stores a pointer + published version", async () => {
  mocks.read.mockResolvedValue(readResult(1));
  mocks.analyze.mockReturnValue(analyzed());

  const result = await submitRegistrySkillFromGitHub({
    repoUrl: "https://github.com/acme/skills",
    userId: "me",
  });

  assert.equal(result.status, "indexed");
  const upsertArg = mocks.upsert.mock.calls[0]?.[0];
  assert.equal(upsertArg.versionStatus, "published");
  assert.equal(upsertArg.outcome, "indexed");
  assert.match(upsertArg.storagePointer, /^github:acme\/skills@a{40}#skills\/writer$/);
  assert.equal(upsertArg.manifestJson.visibility, "restricted");
  assert.equal(upsertArg.manifestJson.registry.capability, "prompt-only");
  assert.equal(upsertArg.manifestJson.registry.fileManifest[0].path, "SKILL.md");
  // Temp dir cleaned up exactly once.
  assert.equal(mocks.cleanup.mock.calls.length, 1);
});

test("a flagged skill queues for review (draft version)", async () => {
  mocks.read.mockResolvedValue(readResult(1));
  mocks.analyze.mockReturnValue(
    analyzed({ scan: { reviewRequired: true, flags: ["egress:pipe-to-shell"] } }),
  );

  const result = await submitRegistrySkillFromGitHub({
    repoUrl: "https://github.com/acme/skills",
    userId: "me",
  });

  assert.equal(result.status, "queued");
  assert.equal(mocks.upsert.mock.calls[0]?.[0]?.versionStatus, "draft");
});

test("an ownership conflict throws and still cleans up", async () => {
  mocks.read.mockResolvedValue(readResult(1));
  mocks.analyze.mockReturnValue(analyzed());
  mocks.getExisting.mockResolvedValue({
    ownerUserId: "victim",
    definitionStatus: "active",
    currentVersionStatus: "published",
  });

  await assert.rejects(
    () =>
      submitRegistrySkillFromGitHub({
        repoUrl: "https://github.com/acme/skills",
        userId: "attacker",
      }),
    (error) =>
      error instanceof RegistrySubmissionError &&
      error.code === "REGISTRY_SUBMISSION_CONFLICT",
  );
  assert.equal(mocks.upsert.mock.calls.length, 0);
  assert.equal(mocks.cleanup.mock.calls.length, 1);
});

test("a multi-skill repo aggregates to queued when any skill is flagged", async () => {
  mocks.read.mockResolvedValue(readResult(2));
  mocks.analyze
    .mockReturnValueOnce(analyzed({ slug: "gh-acme-skills-a" }))
    .mockReturnValueOnce(
      analyzed({
        slug: "gh-acme-skills-b",
        scan: { reviewRequired: true, flags: ["injection:override"] },
      }),
    );

  const result = await submitRegistrySkillFromGitHub({
    repoUrl: "https://github.com/acme/skills",
    userId: "me",
  });

  assert.equal(result.status, "queued");
  assert.equal(result.skills.length, 2);
  assert.equal(mocks.upsert.mock.calls.length, 2);
});

test("an invalid skill among several is skipped; valid ones still index", async () => {
  mocks.read.mockResolvedValue(readResult(2));
  mocks.analyze
    .mockImplementationOnce(() => {
      throw new RegistrySubmissionError(
        "REGISTRY_SUBMISSION_INVALID_SKILL",
        "bad frontmatter",
      );
    })
    .mockReturnValueOnce(analyzed());

  const result = await submitRegistrySkillFromGitHub({
    repoUrl: "https://github.com/acme/skills",
    userId: "me",
  });

  assert.equal(result.status, "indexed");
  assert.equal(result.skills.length, 1);
  assert.equal(mocks.upsert.mock.calls.length, 1);
});

test("read failure is surfaced as NOT_SKILL and does not double-clean", async () => {
  mocks.read.mockRejectedValue(new Error("network boom"));

  await assert.rejects(
    () =>
      submitRegistrySkillFromGitHub({
        repoUrl: "https://github.com/acme/skills",
        userId: "me",
      }),
    (error) =>
      error instanceof RegistrySubmissionError &&
      error.code === "REGISTRY_SUBMISSION_NOT_SKILL",
  );
  // read() owns cleanup on its own failure; submit must not clean again.
  assert.equal(mocks.cleanup.mock.calls.length, 0);
});
