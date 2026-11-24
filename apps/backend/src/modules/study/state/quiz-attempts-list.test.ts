import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const access = vi.hoisted(() => ({
  requireStudyVersion: vi.fn(),
  notFound: vi.fn(() => new Error("not found")),
}));
const repository = vi.hoisted(() => ({
  listOwnQuizAttempts: vi.fn(),
  copyInputSources: vi.fn(),
  findOwnQuizAttempt: vi.fn(),
  insertQuizAttempt: vi.fn(),
  saveQuizAttempt: vi.fn(),
}));
vi.mock("./access", () => access);
vi.mock("./repository", () => repository);
vi.mock("../capability", () => ({ loadStudyDerivation: vi.fn() }));
vi.mock("../../artifacts/publish", () => ({ publishArtifact: vi.fn() }));

import { listQuizAttempts } from "./quiz-service";

const quiz = { kind: "quiz", items: [] };

function version(versionNo: number) {
  return {
    owner: { userId: "u1", teamId: "t1", workspaceId: "w1", artifactId: "a1" },
    threadId: null,
    title: null,
    versionId: `version-${versionNo}`,
    versionNo,
    content: quiz,
  };
}

function row(id: string, versionNo: number) {
  return {
    id,
    artifactId: "a1",
    versionNo,
    itemIds: [],
    answers: {},
    score: null,
    total: 0,
    startedAt: new Date("2026-11-22T00:00:00.000Z"),
    finishedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

test("attempts of the version a viewer holds are listed by that version's number", async () => {
  access.requireStudyVersion.mockResolvedValue(version(1));
  repository.listOwnQuizAttempts.mockResolvedValue([row("attempt-1", 1)]);

  const result = await listQuizAttempts({
    workspaceId: "w1",
    userId: "u1",
    artifactId: "a1",
    artifactVersionId: "version-1",
  });

  assert.deepEqual(access.requireStudyVersion.mock.calls[0]![0], {
    workspaceId: "w1",
    userId: "u1",
    artifactId: "a1",
    artifactVersionId: "version-1",
    artifactType: "quiz",
  });
  assert.deepEqual(repository.listOwnQuizAttempts.mock.calls[0]![0], {
    userId: "u1",
    artifactId: "a1",
    limit: 20,
    versionNo: 1,
  });
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["attempt-1"],
  );
});

test("without a version every version's attempts are listed", async () => {
  access.requireStudyVersion.mockResolvedValue(version(2));
  repository.listOwnQuizAttempts.mockResolvedValue([row("attempt-2", 2), row("attempt-1", 1)]);

  await listQuizAttempts({ workspaceId: "w1", userId: "u1", artifactId: "a1" });

  assert.equal(
    "versionNo" in (repository.listOwnQuizAttempts.mock.calls[0]![0] as object),
    false,
  );
});
