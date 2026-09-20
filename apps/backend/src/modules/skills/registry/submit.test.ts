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
}));

vi.mock("./read", () => ({ readRegistrySkillsFromGitHub: mocks.read }));
vi.mock("./analyze", () => ({ analyzeRegistrySkill: mocks.analyze }));
vi.mock("./repository", () => ({
  getRegistrySkillForSubmission: mocks.getExisting,
  upsertRegistrySkillIndex: mocks.upsert,
}));
vi.mock("../../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import { RegistrySubmissionError } from "./errors";
import {
  analyzeSubmittedSkills,
  summarizeSubmission,
  writeSubmittedSkill,
} from "./submit";

// The ingest pipeline runs these three as separate stages (ingest/stages.ts);
// composed here so their contract with each other is tested in one place.
async function submitRegistrySkillFromGitHub(input: {
  repoUrl: string;
  userId: string;
}) {
  const read = await mocks.read(input.repoUrl);
  const analyzedSkills = await analyzeSubmittedSkills({
    owner: read.source.owner,
    repo: read.source.repo,
    skills: read.skills,
  });
  const results = [];
  for (const skill of analyzedSkills) {
    results.push(
      await writeSubmittedSkill({ read, userId: input.userId, skill }),
    );
  }
  return summarizeSubmission(results, input.repoUrl);
}

function readResult(skillCount = 1) {
  return {
    source: {
      owner: "acme",
      repo: "skills",
      repoUrl: "https://github.com/acme/skills",
    },
    commitSha: "a".repeat(40),
    committedAt: "2026-02-01T10:00:00.000Z",
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
    scan: { reviewRequired: false, flags: [] as string[] },
    fileManifest: [
      {
        path: "SKILL.md",
        sha256: "h",
        sizeBytes: 1,
        role: "model-readable" as const,
      },
    ],
    allowedTools: [] as string[],
    diagnostics: [],
    findings: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getExisting.mockResolvedValue(null);
  mocks.upsert.mockImplementation(async (input) => ({
    status: input.outcome,
    flags: input.manifestJson.registry.scan.flags,
    diagnostics: input.manifestJson.registry.ingestion.diagnostics,
    skillVersionId: "version-1",
    version: "a".repeat(12),
  }));
});

test("a clean, new skill indexes and stores a pointer + published version", async () => {
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
  assert.match(
    upsertArg.storagePointer,
    /^github:acme\/skills@a{40}#skills\/writer$/,
  );
  assert.equal(upsertArg.manifestJson.visibility, "restricted");
  assert.equal(upsertArg.manifestJson.registry.capability, "prompt-only");
  assert.equal(
    upsertArg.manifestJson.registry.fileManifest[0].path,
    "SKILL.md",
  );
});

test("the commit date rides into the stored manifest", async () => {
  mocks.analyze.mockReturnValue(analyzed());
  mocks.read.mockResolvedValue(readResult(1));
  await submitRegistrySkillFromGitHub({ repoUrl: "acme/skills", userId: "me" });
  assert.equal(
    mocks.upsert.mock.calls[0]?.[0].manifestJson.registry.committedAt,
    "2026-02-01T10:00:00.000Z",
  );
});

test("a skill the reader refused for its size is that skill's failure; the rest still index", async () => {
  const read = readResult(2);
  Object.assign(read.skills[0]!, {
    rejection: new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_TOO_LARGE",
      "Skill 'skills/s0' has 201 files, more than the 200-file limit for one skill",
    ),
  });
  mocks.read.mockResolvedValue(read);
  mocks.analyze.mockReturnValue(analyzed());

  const result = await submitRegistrySkillFromGitHub({
    repoUrl: "https://github.com/acme/skills",
    userId: "me",
  });

  assert.equal(result.status, "indexed");
  assert.equal(result.skills[0]?.status, "failed");
  assert.equal(
    result.skills[0]?.diagnostics[0]?.code,
    "REGISTRY_SUBMISSION_TOO_LARGE",
  );
  // Never analyzed, never written — not indexed with part of it missing.
  assert.equal(mocks.analyze.mock.calls.length, 1);
  assert.equal(mocks.upsert.mock.calls.length, 1);
});

test("a flagged skill queues for review (draft version)", async () => {
  mocks.read.mockResolvedValue(readResult(1));
  mocks.analyze.mockReturnValue(
    analyzed({
      scan: { reviewRequired: true, flags: ["egress:pipe-to-shell"] },
    }),
  );

  const result = await submitRegistrySkillFromGitHub({
    repoUrl: "https://github.com/acme/skills",
    userId: "me",
  });

  assert.equal(result.status, "queued");
  assert.equal(mocks.upsert.mock.calls[0]?.[0]?.versionStatus, "draft");
});

test("an ownership conflict throws before any upsert", async () => {
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
      error.code === "REGISTRY_SUBMISSION_NOT_SKILL" &&
      (
        error.details?.skills as Array<{ diagnostics: Array<{ code: string }> }>
      )[0]?.diagnostics[0]?.code === "REGISTRY_SUBMISSION_CONFLICT",
  );
  assert.equal(mocks.upsert.mock.calls.length, 0);
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
  assert.equal(result.skills.length, 2);
  assert.equal(result.skills[0]?.status, "failed");
  assert.equal(mocks.upsert.mock.calls.length, 1);
});

test("unexpected read failures are not mislabeled as invalid skills", async () => {
  mocks.read.mockRejectedValue(new Error("network boom"));

  await assert.rejects(
    () =>
      submitRegistrySkillFromGitHub({
        repoUrl: "https://github.com/acme/skills",
        userId: "me",
      }),
    (error) => error instanceof Error && error.message === "network boom",
  );
});

test("submission persists the detected logo and hands the index every file as bytes", async () => {
  const read = readResult(1);
  const skillMd = Buffer.from(
    "---\nname: writer\ndescription: Writer\nlogo: https://example.com/writer.png\n---\nBody",
  );
  const font = new Uint8Array([0, 1, 0, 0, 255, 254]);
  Object.assign(read.skills[0]!, {
    files: [
      {
        bundlePath: "SKILL.md",
        bytes: skillMd,
        isText: true,
        contentText: skillMd.toString("utf8"),
        mimeType: "text/markdown",
        sizeBytes: skillMd.byteLength,
        sha256: "hash",
      },
      {
        bundlePath: "fonts/Inter.ttf",
        bytes: font,
        isText: false,
        contentText: null,
        mimeType: "font/ttf",
        sizeBytes: font.byteLength,
        sha256: "font-hash",
      },
    ],
  });
  mocks.read.mockResolvedValue(read);
  mocks.analyze.mockReturnValue(analyzed());
  await submitRegistrySkillFromGitHub({
    repoUrl: "https://github.com/acme/skills",
    userId: "me",
  });
  const saved = mocks.upsert.mock.calls[0]![0];
  assert.deepEqual(saved.manifestJson.logo, {
    url: "https://example.com/writer.png",
    source: "skill",
  });
  assert.deepEqual(saved.files, [
    { path: "SKILL.md", bytes: skillMd, mimeType: "text/markdown" },
    { path: "fonts/Inter.ttf", bytes: font, mimeType: "font/ttf" },
  ]);
  // The content hash is the bundle's digest, which only the index can know.
  assert.equal("contentHash" in saved, false);
});
